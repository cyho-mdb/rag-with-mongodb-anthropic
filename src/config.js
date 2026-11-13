// Application settings. Committed to git.
// Secrets and per-machine values (connection string, database name) go in .env instead.
// One setting here can be overridden from .env: the answer model (ANSWER_MODEL).

module.exports = {
  collections: {
    uploads: 'uploads',
    chunks: 'chunks',
  },

  // Atlas Search index names. The definitions are in src/indexes.js.
  searchIndexes: {
    vector: 'chunks_vector_cosine',        // on chunks
    title: 'uploads_title_autocomplete',   // on uploads
    keyword: 'chunks_keyword',             // on chunks, for hybrid search
  },

  // Title search (GET /api/uploads/search): how many suggestions, and the typo
  // tolerance (one edit: a wrong, missing, extra or swapped letter). Typos only count
  // from fuzzyFrom letters on; on shorter input they match too much.
  titleSearch: {
    limit: 8,
    fuzzyFrom: 4,
  },

  // The picker's facets (milestone 10; GET /api/uploads/facets): the file types, and
  // the sizes by chunk count, each below the next one's start (small: under 10 chunks,
  // medium: 10–99, large: 100 or more). A chunk is about 1,600 characters, so large is
  // about a book.
  facets: {
    types: ['pdf', 'md', 'txt'],
    sizes: [
      { name: 'small', below: 10 },
      { name: 'medium', below: 100 },
      { name: 'large' },
    ],
  },

  // Vector search (src/search.js). numCandidates applies to "All uploads" (approximate
  // search) only: how many nearest chunks Atlas considers before keeping the top results
  // (`limit`, or rerank.candidates when reranking). The Atlas documentation suggests at
  // least 20× the results; Atlas caps it at 10,000.
  search: {
    // How many chunks go to the LLM. 10, not 5: broad questions (summaries, overviews)
    // then cover a small or medium upload fully. See Findings in docs/PROJECT_PLAN.md
    // (Broad questions).
    limit: 10,
    candidatesPerResult: 20,
    // "Not found" thresholds on the top score, one per search mode: below it, the app
    // replies "not found in your uploads" without calling the LLM. These are for
    // vector-only searches (cosine scores): answers asked without reranking, and the
    // test tools' --no-rerank. Reranked answers use rerank.notFoundThreshold below.
    // See Findings in docs/PROJECT_PLAN.md ("Not found" score threshold), re-checked with the
    // PDFs and with several selected uploads (Findings: Several ticked uploads).
    notFoundThreshold: {
      selectedUploads: 0.62,
      allUploads: 0.62,
    },
    // Reranking (milestone 9), the default for answers: vector search fetches the top
    // `candidates` chunks, a Voyage AI model re-sorts them, and the top `limit` are kept.
    // The thresholds are on the top rerank score, which has its own scale. Chosen from
    // the runs of 2026-10-09 (test/results/2026-10-09-rerank-50.md): 0.58 sends every
    // answerable question to the LLM with room to spare and stops most unanswerable ones.
    // Hybrid search uses the same candidates (from each side) and thresholds.
    rerank: {
      model: 'rerank-3',
      candidates: 50,
      notFoundThreshold: {
        selectedUploads: 0.58,
        allUploads: 0.58,
      },
    },
    // Hybrid search (milestone 9; src/search.js): the keyword side's typo tolerance, in
    // letters a word may differ by (1: a wrong, missing, extra or swapped letter). 2
    // would let short words match unrelated ones ("ram" and "run").
    hybrid: {
      fuzzyMaxEdits: 1,
    },
  },

  // Answers (src/answer.js). The API key is in .env (ANTHROPIC_API_KEY).
  answer: {
    // The Claude model that writes the answers. ANSWER_MODEL in .env overrides it
    // (see .env.example); the prompt and the test runs were tuned on the default.
    model: (process.env.ANSWER_MODEL || '').trim() || 'claude-sonnet-5-5',
    // Output cap per answer, including the model's thinking. Answers are short; this
    // only stops a runaway reply.
    maxTokens: 16000,
    notFoundReply: 'not found in your uploads',
  },

  // Uploads from the web page (POST /api/uploads). The file is held in memory while it
  // is ingested, so this also caps the server's memory per upload.
  upload: {
    maxMegabytes: 50,
    maxFileNameLength: 255,
  },

  // PDF extraction (src/extractors/pdf.js). A PDF averaging fewer characters per page
  // than this is rejected as scanned. Text PDFs here averaged ~800–1,200; covers and
  // picture pages pull the average down, so keep this well below that.
  pdf: {
    minAverageChars: 100,
  },

  // Sizes in characters (≈4 characters per token). Confirmed in milestone 4 against
  // 1,000 (see Findings in docs/PROJECT_PLAN.md: Chunk size). Changing them means
  // re-ingesting, and so re-embedding, every upload.
  chunking: {
    targetSize: 1600,
    maxSize: 2000,
    overlap: 200,
  },
};
