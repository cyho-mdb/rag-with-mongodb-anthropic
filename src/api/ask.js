// POST /api/ask: answers a question from the ticked uploads or all uploads (see
// docs/API_SPEC.md: Questions). Body: { question, uploadIds } or { question, scope: "all" },
// plus rerank: false for an answer from vector search alone (reranked by default), or
// search: "hybrid" for hybrid search (always reranked).
// Checks the request, then calls src/answer.js, and sends only the fields the spec
// lists: the answer's extra fields (text, chunks, rawText, usage) stay on the server.

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { answer } = require('../answer');
const { HybridUnavailable } = require('../search');
const { ApiError } = require('./errors');
const { toObjectId } = require('./ids');

const MAX_QUESTION_LENGTH = 1000;

// HTTP statuses from the Anthropic API that mean "busy, try again later": rate-limited
// (429), unavailable (503), overloaded (529). The SDK has already retried twice.
const LLM_BUSY = [429, 503, 529];

// HTTP statuses from the Anthropic API (or a gateway in front of it, see
// ANTHROPIC_BASE_URL in .env.example) that mean "this server isn't allowed in": a wrong
// or missing key (401), or access denied (403), e.g. a company gateway reached from
// outside its network. Retrying won't help; the server's settings need fixing.
const LLM_REFUSED = [401, 403];

module.exports = function askRoutes(db) {
  const router = express.Router();
  const uploads = db.collection(config.collections.uploads);

  // express.json() reads the JSON body into req.body (only for this route).
  router.post('/ask', express.json(), async (req, res) => {
    const { question, uploadIds, rerank, search } = await readRequest(req.body ?? {}, uploads);

    let result;
    try {
      result = await answer(db, question, { uploadIds, rerank, search });
    } catch (err) {
      if (err instanceof HybridUnavailable) {
        console.error('Ask: hybrid search unavailable:', err.message);
        throw new ApiError(503, 'hybridUnavailable',
          'Hybrid search isn\'t available right now. Ask with vector search instead.');
      }
      if (llmBusy(err)) {
        console.error('Ask: answer service unavailable:', err.message);
        throw new ApiError(503, 'llmUnavailable', 'The answer service is busy right now. Try again in a minute.');
      }
      if (err instanceof Anthropic.APIError && LLM_REFUSED.includes(err.status)) {
        console.error('Ask: answer service refused access:', err.message);
        throw new ApiError(502, 'llmAccessDenied',
          'The answer service refused this server\'s access. Check the API key settings.');
      }
      // 404 from the Anthropic API: it doesn't know the model, or the key can't use it.
      if (err instanceof Anthropic.NotFoundError) {
        console.error(`Ask: answer model "${config.answer.model}" not found:`, err.message);
        throw new ApiError(502, 'llmModelNotFound',
          `The answer service doesn't know the model "${config.answer.model}". Check ANSWER_MODEL in the server's .env file.`);
      }
      throw err;   // anything else, including a cut-off reply: 500
    }
    res.json(toApiAnswer(result));
  });

  return router;
};

// Checks the body and returns the question, the uploadIds (undefined for all uploads),
// whether to rerank and the kind of search. Throws an ApiError for anything the spec
// rejects.
async function readRequest(body, uploads) {
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question) throw new ApiError(400, 'missingQuestion', 'Type a question first.');
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new ApiError(400, 'questionTooLong', `Questions can be up to ${MAX_QUESTION_LENGTH} characters.`);
  }
  // Only a real boolean: a string "false" would otherwise count as true.
  const rerank = body.rerank ?? true;
  if (typeof rerank !== 'boolean') throw new ApiError(400, 'invalidRerank', 'rerank must be true or false.');
  const search = body.search ?? 'vector';
  if (search !== 'vector' && search !== 'hybrid') {
    throw new ApiError(400, 'invalidSearch', 'search must be "vector" or "hybrid".');
  }
  // The merged score of hybrid search can't be checked against a threshold.
  if (search === 'hybrid' && !rerank) {
    throw new ApiError(400, 'invalidSearch', 'Hybrid search is always reranked; leave out rerank: false.');
  }

  // Exactly one of uploadIds (one or more) or scope "all". An empty list is refused,
  // so a bug that sends one can't quietly search everything.
  const { uploadIds, scope } = body;
  const missing = () => new ApiError(400, 'missingScope', 'Tick at least one upload, or All uploads.');
  const invalid = (message) => new ApiError(400, 'invalidScope', message);
  if (uploadIds === undefined && scope === undefined) throw missing();
  if (uploadIds !== undefined && scope !== undefined) {
    throw invalid('Send either uploadIds or scope: "all", not both.');
  }
  if (scope !== undefined) {
    if (scope !== 'all') throw invalid('scope can only be "all".');
    return { question, uploadIds: undefined, rerank, search };
  }
  if (!Array.isArray(uploadIds)) throw invalid('uploadIds must be a list of upload ids.');
  if (!uploadIds.length) throw missing();

  // Each id must be a complete upload that is searchable.
  const ids = [...new Set(uploadIds.map(String))].map(toObjectId);
  const found = await uploads
    .find({ _id: { $in: ids }, status: 'complete' }, { projection: { searchableAt: 1 } })
    .toArray();
  if (found.length < ids.length) {
    throw new ApiError(404, 'uploadNotFound', 'One of the ticked uploads no longer exists.');
  }
  if (found.some((upload) => !upload.searchableAt)) {
    throw new ApiError(409, 'uploadNotReady', 'One of the ticked uploads is still being processed.');
  }
  return { question, uploadIds: ids, rerank, search };
}

function llmBusy(err) {
  return err instanceof Anthropic.APIConnectionError   // includes timeouts
    || (err instanceof Anthropic.APIError && LLM_BUSY.includes(err.status));
}

// The answer as docs/API_SPEC.md lists it, with ids as hex strings.
function toApiAnswer(result) {
  const withHexIds = (hits) => hits.map((hit) => ({ ...hit, uploadId: hit.uploadId.toHexString() }));
  const { withoutRerank } = result.retrieval;
  return {
    found: result.found,
    reason: result.reason,
    parts: result.parts,
    citations: result.citations.map((c) => ({
      n: c.n,
      uploadId: c.uploadId.toHexString(),
      title: c.title,
      fileName: c.fileName,
      fileType: c.fileType,
      section: c.section,
      page: c.page,
      chunkIndex: c.chunkIndex,
      chunkCount: c.chunkCount,
      excerpt: c.excerpt,
    })),
    retrieval: {
      ...result.retrieval,
      hits: withHexIds(result.retrieval.hits),
      withoutRerank: withoutRerank && { ...withoutRerank, hits: withHexIds(withoutRerank.hits) },
    },
  };
}
