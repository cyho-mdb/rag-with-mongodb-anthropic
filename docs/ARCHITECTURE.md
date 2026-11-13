# Architecture

A map of the code: what each folder and file is for, and how they fit together.
Details live in each file's header comment; decisions and reasons live in
PROJECT_PLAN.md. Keep this map short. It is updated at the end of each milestone,
so during one it may lag behind the files.

## How it works

```
file ──► extractor ──► splitter ──► chunks collection ──► Atlas Auto-Embedding
         (sections)    (chunks)     (text + metadata)     (vectors, in the vector index)

question ──► vector search ──► rerank ─────► threshold check ──► LLM answer with citations
             (top 50; Atlas    (Voyage AI    (top score; below it:
              embeds the        re-sorts,     "not found", no LLM call)
              question)         top 10)
```

The app never creates vectors: it stores chunk text, and Atlas embeds it in the
background through the vector search index. New chunks become searchable a few
seconds after they are saved.

Answers are reranked by default: vector search fetches the 50 closest chunks, the
`$rerank` stage re-sorts them by how well each answers the question, and the top 10
go on. The threshold then checks the top rerank score. Asked without reranking
(`rerank: false`, `--no-rerank`), the top 10 come from vector search alone and the
threshold checks the cosine score. `test/RERANKING.md` compares the two. Each
reranked answer also says which passages vector search alone would have sent: the
top 10 of the same 50 candidates in vector order, so no second search runs. The page
shows both lists in "How this was found", in two tabs.

Hybrid search is an option (`search: "hybrid"`, `--search hybrid`), not the default and
not on the page: vector search and keyword search (the Atlas Search index
`chunks_keyword`) each fetch 50 chunks, `$rankFusion` merges them, and `$rerank`
re-sorts the whole merged list before the top 10 go on. It's always reranked, at the
same threshold. `test/HYBRID.md` shows it made no measurable difference here.

The LLM (Claude, through the Anthropic API) gets the top chunks as search results and
cites the ones it uses; each citation maps back to an upload and section. A reply with
no citations counts as "not found in your uploads".

An upload is searchable once all its chunks are embedded: the readiness check (an
exact vector search and a count) then sets `searchableAt`, and only then does the
upload take part in "All uploads" and become selectable on the page.

The API server (`server.js`, Express) offers all of this over HTTP for the web page:
listing, uploading and title search of uploads, readiness checks, and questions.
The picker's Filter block counts uploads by file type and size with Atlas Search
facets (`$searchMeta`) on the same title index, for the whole library; its chips
filter the list and the title search. API_SPEC.md describes its routes and formats. The web page (`public/`) is served by
the same server at `/` and runs in the browser: it calls the routes, and keeps the
earlier questions in the browser's `localStorage`.

## Call chains

Where each part of the app starts, and which files it calls, in order. An arrow means
"calls". A file that calls several lists them with commas, or, when the line would get
long, with a second arrow on the next line, under the arrow it branches from.

```
npm start              → server.js → src/indexes.js (startup check)
                                   → the routes below, one per request:
  GET  /api/health          → src/api/health.js
  GET  /api/uploads         → src/api/uploads.js
  GET  /api/uploads/search  → src/api/uploads.js → src/title-search.js
  GET  /api/uploads/facets  → src/api/uploads.js → src/title-search.js
  GET  /api/uploads/:id     → src/api/uploads.js → src/readiness.js
  POST /api/uploads         → src/api/uploads.js → src/ingest.js → src/extractors/, src/splitter.js
  POST /api/ask             → src/api/ask.js → src/answer.js → src/search.js
web page (browser)     → public/index.html (served by npm start at /) → public/app.js → public/api.js (the routes above)
                                                                                      → public/format.js
npm run ask            → scripts/ask.js → src/answer.js → src/search.js
npm run ingest         → scripts/ingest-file.js → src/ingest.js → src/extractors/, src/splitter.js
                                                → src/readiness.js (waits until searchable)
npm run setup          → scripts/setup-db.js → src/indexes.js, src/readiness.js
npm run search         → tools/search.js → src/search.js
npm run test-questions → tools/run-test-questions.js → src/search.js
npm run test-answers   → tools/run-test-answers.js → src/answer.js → src/search.js
npm run chunk          → tools/chunk-file.js → src/extractors/, src/splitter.js  (no database)
npm run cleanup        → tools/cleanup.js → src/ingest.js (removeUploads)
npm run check-db       → tools/check-db.js
npm run index-status   → tools/index-status.js → src/indexes.js
npm run probe          → tools/probe.js → src/readiness.js
```

`npm run dev` is `npm start` that restarts whenever a file changes, for use while
editing. On Windows its restarts and Ctrl+C end the server with a hard kill, so
"Server stopped." doesn't show (harmless); use `npm start` for demos and a clean stop.

Inside `src/extractors/`:
- `index.js` picks `text.js`, `markdown.js` or `pdf.js` by file extension.
- `markdown.js` reuses the decoder in `text.js`.
- `index.js` and `pdf.js` share `title.js`.

Left out of the chains:
- `src/db.js`: each starting file opens the connection with it and passes it down;
  `src/` modules never open their own. The server opens one at startup and shares it.
- `src/config.js`: read almost everywhere.
- `src/upload-error.js`: thrown by `src/ingest.js` and the extractors.
- `src/api/errors.js` and `src/api/ids.js`: used by every route.
- `tools/test-modes.js`: shared by both test runners.

## Folders

Scripts and tools import from `src/`, never the reverse.

### `src/`: app code, used by the app at runtime

| File | Purpose |
|---|---|
| `config.js` | Application settings: collection and search index names, search limits, "not found" thresholds (all uploads, selected uploads; cosine for vector search alone, and their own for reranking), reranking (model, candidates), hybrid search's typo tolerance, answer model (`ANSWER_MODEL` in `.env` overrides it), upload size and file-name limits, title search settings, the picker's facets (file types, size buckets by chunk count), scanned-PDF threshold, chunk sizes. Secrets go in `.env` instead. |
| `db.js` | Opens the MongoDB connection from `.env` (`MONGODB_URI`, `DB_NAME`). |
| `extractors/index.js` | Picks the extractor for a file by its extension; rejects unsupported types. |
| `extractors/text.js` | Plain text: the whole file is one section; its chunks start with a title made from the file name. Also decodes file bytes to text. |
| `extractors/markdown.js` | Markdown: each heading starts a section, named by its heading path; the first `#` heading is the title. |
| `extractors/pdf.js` | PDF (text-based, via `unpdf`): each page is a section ("page 12"), read in visual order (code blocks back in place, columns kept apart); drops running headers, footers and page numbers, takes chapter names from the headers for the prefix ("Title > Chapter"), repairs sentences cut by a page break, rejects scanned PDFs. |
| `extractors/title.js` | Makes a title from a file name, for files without one. |
| `splitter.js` | Splits sections into overlapping chunks (paragraphs → sentences → lines → words); each chunk starts with its section name, or the section's prefix if the extractor gives one (plain text: the title; PDFs: the title, and the chapter if found). |
| `ingest.js` | Saves an upload and its chunks, all or nothing (`processing` → `complete`); rejects duplicate file names. |
| `upload-error.js` | `UploadError`: an upload problem the user can fix (duplicate, unsupported type, scanned PDF…), with a code the API turns into a 4xx. |
| `readiness.js` | The readiness check: counts an upload's searchable chunks (exact vector search, then `$count`) and sets `searchableAt` once all are. |
| `search.js` | Vector search for a question: exact within the selected uploads, approximate across all searchable ones; optionally reranks a number of candidates (`$rerank`); or hybrid search (`kind: 'hybrid'`: vector and keyword search merged by `$rankFusion`, then reranked); joins each chunk's upload (`$lookup`). Returns the chunks with their score (rerank or cosine), cosine `vectorScore`, rank in each list before reranking (`vectorRank`, `keywordRank`) and after it (`rerankRank`), and merged `fusionScore`; for reranked vector search also the top chunks in vector order (`vectorTop`, what vector search alone would have returned); and the kind, mode, reranking (with the count actually reranked) and counts. Throws `HybridUnavailable` when the keyword index is missing. |
| `answer.js` | Answers a question: search (reranked unless asked with `rerank: false`; hybrid with `search: 'hybrid'`), then the "not found" threshold check, then the LLM with citations. Returns the answer as parts, citations and retrieval details (the API's format), including, when reranked, what vector search alone would have sent and whether its threshold would have stopped the question (`withoutRerank`). Holds the system prompt. |
| `indexes.js` | The Atlas Search index definitions (vector, title autocomplete with the facet fields, keyword) and their status. |
| `title-search.js` | The page's picker, on the title index: title search (Atlas Search autocomplete on titles and file names, with typo tolerance) and facet counts by type and size (`$searchMeta`, one query per row), both filtered by the ticked chips. Remembers a working title index until the server stops. |

### `src/api/`: the API server's routes (used by `server.js`)

Route files handle a request first; helpers are only called by them.

| File | Routes it handles | Purpose |
|---|---|---|
| `health.js` | `GET /api/health` | Whether the server can reach the database. |
| `uploads.js` | `GET /api/uploads`<br>`GET /api/uploads/search`<br>`GET /api/uploads/facets`<br>`GET /api/uploads/:id`<br>`POST /api/uploads` | Upload routes: the list, title search, the facet counts, one upload with its readiness check, and the upload itself (`multer`). Checks the ticked chips (`type`, `size`). |
| `ask.js` | `POST /api/ask` | Checks the request (including the optional `rerank` and `search`), answers it, and sends the fields API_SPEC.md lists (including `withoutRerank`); turns a busy or refusing LLM, or a missing keyword index, into its own error codes. |
| `errors.js` | Any other `/api` route (a 404) | Helper: `ApiError`, and the error handler that turns every route's errors into `{ error: { code, message } }`. |
| `ids.js` | – | Helper: turns upload ids from requests into ObjectIds, or a 400 (for `uploads.js` and `ask.js`). |

### `public/`: the web page (served by `server.js`)

Plain HTML, CSS and JavaScript, run by the browser as it is: no build step and no
framework. The scripts are browser modules (`import`/`export`), so Node can't load
them as they are (`package.json` has no `"type": "module"`). Built from
`wireframe/index-green.html`; how the page uses each route is in API_SPEC.md.

| File | Purpose |
|---|---|
| `index.html` | The page's fixed frame: header, sidebar (upload, Filter block, title search, picker) and workspace (question box, answers). |
| `style.css` | The page's styles (green scheme), with the phone layout below 760 px. |
| `app.js` | The page itself: its state, the functions that draw each area from it, and the events. Upload list and connection banners, picker and title search, the Filter block (facet chips that filter the list and the suggestions), uploads and readiness checks, questions and answer cards (with "How this was found", which compares the reranked passages with vector search alone's in two tabs), earlier questions in `localStorage`. |
| `api.js` | Calls the API routes; turns a failed request into `ServerUnreachable` (no reply) or `ApiError` (a reply with an error code). |
| `format.js` | Turns untrusted text into HTML: answers (escaping, the Markdown subset with fenced code blocks, citation markers), citation locations ("PDF p. 12", a heading path, "passage 2 of 7", "Opening text"), relative times, and title search highlights. |

### `scripts/`: needed to make the app work

Setup, and the command-line versions of uploading and asking.

| File | Command | Purpose |
|---|---|---|
| `setup-db.js` | `npm run setup [-- --update <index name>]` | Creates the collections, regular indexes and search indexes (skips ones that exist), then sets `searchableAt` on complete uploads that lack it. `--update` applies a changed definition to the title or keyword index in place (never the vector index). |
| `ingest-file.js` | `npm run ingest -- <file>` | Uploads a file from the command line, then waits until it is searchable. |
| `ask.js` | `npm run ask -- "<question>" [--upload <fileName>]... [--no-rerank \| --search hybrid]` | Asks a question from the command line, of all uploads or the ones named; prints the answer and its sources. Reranked unless `--no-rerank`; `--search hybrid` for hybrid search. |

### `tools/`: maintenance and testing, not needed for the app to work

Everything that shows the app's internals.

| File | Command | Purpose |
|---|---|---|
| `check-db.js` | `npm run check-db` | Connection check and MDB doc counts per collection. |
| `index-status.js` | `npm run index-status` | Status of each search index, or that it's missing, and any fields it lacks (an older definition, to update with `npm run setup -- --update`). |
| `probe.js` | `npm run probe -- <fileName>` | How many of an upload's chunks are searchable, and how long since upload. Only counts; never sets `searchableAt`. |
| `chunk-file.js` | `npm run chunk -- <file> [--full]` | Chunking preview, no database: each chunk's start and end on one line, with the PDF prefix; `--full` prints whole chunks. |
| `search.js` | `npm run search -- "<question>" [--upload <fileName>]...` | Raw search results with scores (rerank and cosine), for testing and tuning. Reranked like answers; `--rerank <n>` reranks another number of candidates, `--no-rerank` shows vector search alone, `--search hybrid` hybrid search; each result shows its rank in each list. |
| `run-test-questions.js` | `npm run test-questions` | Runs `test/questions.json` through search only: scores, ranks, whether the answer text was retrieved, and what the threshold does (sent to the LLM or stopped). Reranked by default; `--no-rerank` for vector search alone, `--search hybrid` for hybrid search, `--rerank <n>` and `--threshold <score>` to try other values. `--save <label>` writes a report to `test/results/`. Its header describes the question fields and kinds. |
| `run-test-answers.js` | `npm run test-answers` | Runs `test/questions.json` through the answer function (calls the LLM): Pass/Fail per reply, with a diagnosis for each Fail. `--save <label>` writes a report with every answer; `--only <ids>` runs a few questions; `--limit <n>` sends n chunks to the LLM instead of `config.js`'s; `--no-rerank` answers from vector search alone, `--search hybrid` from hybrid search. |
| `cleanup.js` | `npm run cleanup` | Removes orphan chunks, stale ingests, or one named upload. Lists first; `--yes` removes. |
| `test-modes.js` | – | The search modes both test runners use (all, one, wrong, several) and when each expects an answer. |

### `test/`: test questions, saved test runs, and what they showed

`questions.json` holds the test questions against the samples: which upload should
answer each, the answer phrases, a wrong upload for each answerable one, and for some,
several uploads to search together. Fields and kinds are described in
`tools/run-test-questions.js`.

`results/` holds one Markdown report per saved run:
`npm run test-questions -- --save <label>` writes `<date>-<label>.md` (search scores),
and `npm run test-answers -- --save <label>` writes `<date>-answers-<label>.md`
(answers, with the system prompt used). Each report lists the settings that affect its
results. Findings in PROJECT_PLAN.md name the date of the runs they rely on.

`RERANKING.md` is a hand-written comparison of reranked answers with vector search
alone (milestone 9), built from the saved reports it links to. Its two charts are in
`charts/` (static SVG, light and dark), drawn by a one-off script that isn't kept in
the repository.

`HYBRID.md` does the same for hybrid search against vector search, both reranked
(milestone 9), from two saved reports and two one-off comparisons whose results it
records.

### `samples/`: test files to upload

Small files on unrelated topics (the fictional Nimbus CLI, MongoDB's document model,
Claude Code), in both `.md` and `.txt`, so searches across all uploads have
distractors. Written as test data, not as reference material.

`samples/private-samples/` holds real files for testing, such as PDFs of books. It's
gitignored, since they may be copyrighted.

`samples/pdf-mocks/` holds small made-up PDFs for layouts the real ones lack: running
headers and footers (fixed, numbered, chapter names, book-style alternating, two
columns, a repeated body heading that must stay) and scanned pages (rejected, or
skipped in a text PDF). Check them with `npm run chunk -- <file>`. They are generated
by a script kept outside the repository, whose header lists each mock's expected
result.

### `wireframe/`: static mock-up of the web page

`index.html`: one self-contained page with fake data and no backend, opened straight
from disk. A state menu at the top switches between answers, "not found", errors,
uploads and rejections, title search, and an empty library; each state names the API
route behind it. Not part of the app, and not updated after milestone 7 (see
milestone 8 in PROJECT_PLAN.md).

`index-green.html`: the same page in a light green scheme modelled on MongoDB's
palette. Only the colours and the empty-state icons differ. Milestone 8 built the
real page (`public/`) from this one.

`index-facets.html`: a copy of `index-green.html` with only the sidebar changed, for
milestone 10: the Filter block, the filtered list, and the selection row and groups
as the real page has them. Its own "Facets (proposed)" states are in the state menu.
Not updated after milestone 10.

### `images/`: pictures for the README

`answer.png`: a screenshot of the web page (a reranked answer with "How this was
found" open), shown at the top of the README.

### `docs/`: the project's documentation

Paths in these files are from the repository root (`src/search.js`, not
`../src/search.js`).

| File | Purpose |
|---|---|
| `PROJECT_PLAN.md` | What we're building, milestones, decisions, findings, current status. |
| `ARCHITECTURE.md` | This map. |
| `API_SPEC.md` | The API's routes, request and response formats, and error codes, and how the web page uses them (milestones 7–10). |

## Root files

| File | Purpose |
|---|---|
| `server.js` | Starts the API server (`npm start`): connects to Atlas, checks the search indexes, mounts the routes in `src/api/`, serves the web page from `public/`, and listens on `127.0.0.1:3000` unless `HOST` or `PORT` is set. |
| `README.md` | The project for a portfolio reader: what it showcases, the architecture diagram (Mermaid), the main queries as example code, results, quick start, Troubleshooting. Links here rather than repeating this map. |
| `LICENSE` | MIT license. |
| `CLAUDE.md` | Working preferences for Claude Code. Local only (gitignored). |
| `HANDOFF.md` | Short-lived notes for the next session, updated at each handoff. Local only (gitignored). |
| `.env` | Secrets and per-machine values. Never committed. |
| `.env.example` | The variables `.env` needs, with placeholder values. Committed. |
