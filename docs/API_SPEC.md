# API spec

The Express API (milestone 7) and how the web page (milestone 8) uses it: routes,
request and response formats, error codes, and the `src/` changes milestone 7 made.
Milestone 9 added reranking, hybrid search and the page's comparison with vector
search alone, marked "(milestone 9)" where they appear. Milestone 10 adds the picker's
facets, from `wireframe/index-facets.html`, marked "(milestone 10)".
Written before milestone 7 from the wireframe (`wireframe/index.html`, whose state
menu names the route behind each state), and kept in step with the routes as they
were built. Decisions and reasons are in PROJECT_PLAN.md; this file is the detail.
Update it when a route changes.

## Conventions

- JSON in and out, except the upload (`multipart/form-data`).
- Ids are an upload's `_id` as a 24-character hex string. The server converts them to
  ObjectIds (the vector index filter needs ObjectIds); a malformed id is a 400.
- Errors: an HTTP status plus `{ "error": { "code": "...", "message": "..." } }`. The
  message is written for the user. The page picks its wording by `code`, and shows
  `message` for a code it has no wording for. A 500 says only "Something went wrong";
  the details go to the server log. An unknown `/api` route is a 404 `routeNotFound`.
- "Not found in your uploads" is a normal answer (200), not an error.
- A failed `fetch()` (no HTTP status at all) means the server is unreachable; the page
  handles it apart from API errors, and tells it apart from an unreachable database
  with `GET /api/health`.
- The server listens on `127.0.0.1:3000` by default; `HOST` and `PORT` in `.env`
  change it (e.g. for the VM). It serves the page from `public/` at `/`, so page and
  API share an address and the browser needs no cross-site (CORS) permission.

## Server

### `GET /api/health`

Whether the server can reach the database (a `ping` to Atlas).

- `200` `{ "db": "ok" }`
- `503` `dbUnavailable`

The page calls it on load and whenever a request fails, and drives the header's
connection dot from it ("Connecting…" until the first reply). Its banner then says
which part is down:
- `fetch()` fails: "Can't reach the server. Is it running (`npm start`)?"
- `503`: "The server can't reach the database. Check Atlas Network Access; your IP
  address may have changed."

While a part is down, the page checks again every 5 s; once both are back, it hides
the banner and reloads the upload list, with no page reload needed. Meanwhile the
question box, Upload, title search and the picker (including "All uploads") are
disabled; ticks already there are kept. No checks run while everything works.

## Uploads

Every route returns uploads in this shape:

```json
{
  "id": "66f1c0ffee0000000000abcd",
  "title": "Nimbus Admin Handbook",
  "fileName": "nimbus-admin-handbook.txt",
  "fileType": "txt",
  "chunkCount": 7,
  "uploadedAt": "2026-10-02T09:14:03.120Z",
  "searchable": true
}
```

- Only complete uploads are returned. `status: 'processing'` is the ingest's internal
  state and never reaches the page.
- `searchable` comes from `searchableAt` (set once the upload's chunks are all
  searchable). The page's "processing… → ready" label comes from `searchable`, never
  from `status`.

### `GET /api/uploads`

All complete uploads, sorted by title as a person would: case and accents don't split
the list (a MongoDB collation, locale `en`; without one, "Zebra" sorts before
"apple"). Reports what is stored; it never runs the readiness check, so it stays cheap
however many uploads are processing.

`200` `[upload, ...]`

Uploads are shared, and the command line can add them too, so the page reloads the
list when its browser tab regains focus. It also reloads it on load, when the
connection comes back, after its own upload, after a question fails with
`uploadNotFound` or `uploadNotReady`, when a readiness check gets a 404, and when a
title search suggests an upload it doesn't know yet. A ticked upload missing from the
reloaded list (or no longer searchable) is unticked, with a red notice in the sidebar
naming it: "This upload is no longer available, so it was unticked."

The picker groups uploads by the first letter of the title (accents ignored). Every
group starts open with 20 uploads or fewer, otherwise only the first. Under "All
uploads", a row shows what is ticked, a Clear link while something is, and "Collapse
all", which turns into "Expand all" once every group is closed.

### `GET /api/uploads/search?q=<text>`

Title search for the picker: Atlas Search autocomplete on `title` and `fileName`, with
fuzzy matching (a typo like "nimbsu" finds Nimbus), complete uploads only, at most 8.

- `type`, `size` (optional, milestone 10): the Filter block's ticked chips, as in
  `GET /api/uploads/facets`; only matching uploads are suggested.
- `200` `[upload, ...]`; an empty `q` gives `[]`.
- `400` `invalidFilter` (milestone 10): an unknown `type` or `size` value.
- `503` `titleSearchUnavailable`: the title index is missing (e.g. dropped while being
  changed). The page then filters its own list in the browser. Checked until the
  server first sees the index working, then remembered until it stops, since asking
  Atlas takes about 1 s per search with no matches. An index dropped while the server
  runs isn't noticed until it restarts (searches just find nothing).

How it matches (settled in milestone 7 with the real titles; index in
`src/indexes.js`, query in `src/title-search.js`):
- Every typed word must match the start of a word in the title or the file name, so
  "nim admin" finds only "Nimbus Admin Handbook".
- File names are split into words at hyphens, underscores and dots, so
  "instructions" finds `Shanti_Pouch_Instructions.pdf`. The extension is a word too:
  "pdf" lists the PDFs.
- Suggestions start at 2 letters; a 1-letter word is skipped while another word is
  there ("nimbus g" searches "nimbus").
- Words of 4 letters or more may have one typo ("nimbsu", "aggregatoins").
- Only titles and file names are searched, not the text inside the files.

The page sends a request once typing pauses for about 200 ms, not on every key. At
startup the server warns if the title index is missing; the vector index missing
stops it.

The page:
- Keeps the server's order (best match first) and ignores a late reply to an earlier
  query.
- Highlights only exact word starts: a typo match ("nimbsu") has no exact text to
  mark.
- Falls back to filtering its own list in the browser (word starts, no typos) on any
  failure, not only the 503.
- Opens the dropdown on a click into the search box, showing only its footer until
  2 letters are typed: "Atlas Search · autocomplete on title and file name", or
  "Filtered in the browser: title search is unavailable". It closes on Esc or when the
  box loses focus; ticking a suggestion keeps it open, so several can be ticked.

### `GET /api/uploads/facets?type=<types>&size=<sizes>` (milestone 10)

Counts for the picker's Filter block: complete uploads by file type and by size, with
the Atlas Search `facet` collector (`$searchMeta`) on the title index. The whole
library, not the words typed in the title search (see the page, below).

- `type`, `size` (optional): the ticked chips, comma-separated (`type=pdf,md`,
  `size=medium`). Values: `pdf`, `md`, `txt`; `small`, `medium`, `large`.
- `200`, with every value listed, 0 where nothing matches:
  ```json
  { "type": { "pdf": 2, "md": 3, "txt": 2 }, "size": { "small": 5, "medium": 1, "large": 1 } }
  ```
- `400` `invalidFilter`: an unknown `type` or `size` value.
- `503` `facetsUnavailable`: the title index is missing, or doesn't index `fileType`
  and `chunkCount` yet (an older definition; `npm run setup -- --update
  uploads_title_autocomplete` updates it). The server warns about both at startup,
  and `npm run index-status` shows them.
- `type`, `size` given twice (`type=pdf&type=md`) count like `type=pdf,md`.

How it counts:
- Type: a string facet on `fileType`, indexed as `token`.
- Size: a number facet on `chunkCount`, indexed as `number`, with boundaries 1, 10 and
  100 and the rest in `large`: under 10 chunks is `small`, 10–99 `medium`, 100 or more
  `large`. A chunk is about 1,600 characters.
- Chips in a row combine with "or", the rows with "and". Each row's counts apply the
  other row's chips but not its own, so another value can still be added to a row:
  one `$searchMeta` per row, sent together (one query when no chip is ticked).
- The search index can lag a new upload by a few seconds, so the counts may briefly
  leave it out.

The page:
- Shows the Filter block above the title search (below it, the suggestions would
  cover the chips while they filter them): a row of chips for Type and one for Size,
  each chip with its count, and "Clear filter" while a chip is ticked (not "Clear",
  which the selection row uses for the ticks). A chip with a count of 0 is greyed
  unless it is ticked. Hovering over a Size chip shows its range in chunks.
- Keeps the counts as they are while typing in the title search: the list below isn't
  narrowed by the typed words, so a chip greyed for 0 matches would block a filter
  that works on the list.
- Asks for counts when the list loads or reloads, when a chip changes, and when an
  upload turns ready (by then the search index has caught up). A late reply to an
  earlier request is ignored.
- Filters its own list by the ticked chips (the list has `fileType` and `chunkCount`).
  The picker shows only matching uploads, under a "Showing 6 of 15 uploads" line
  below the selection row (no link: "Clear filter" sits by the chips). Ticking a chip
  opens every group with a match; clearing leaves the groups as they are.
- Keeps ticks the filter hides: the question still asks those uploads (their chips
  above the question box stay), and the selection row says how many are hidden,
  short enough to fit it: "2 selected, 1 hidden", with "1 of them is hidden by the
  filter" on hover. "All uploads" still means every searchable upload.
- Sends the ticked chips with title search too, so the suggestions are filtered: the
  dropdown's footer then ends in "· filtered", and no matches reads "No titles or file
  names match "nim" with this filter."
- On any failure (not only the 503), clears the chips, hides the Filter block and
  shows the whole list. It asks again the next time the list reloads.

### `GET /api/uploads/:id`

One upload. If its `searchableAt` is unset, the server first runs the readiness check
(`src/readiness.js`): an exact vector search filtered to the upload, `limit` =
`chunkCount`, then a count. When the count reaches `chunkCount`, it sets `searchableAt`,
only if still unset, so two tabs checking at once is harmless. Once set, it is never
checked again.

- `200` `upload`, sent with `Cache-Control: no-store` so the browser never answers a
  check from its cache
- `400` `invalidId`
- `404` `uploadNotFound`

The page checks each listed upload whose `searchable` is false every 3 s for the first
minute (counted from when the page starts checking it), then every 15 s, with no
give-up (embedding beyond the rate limit is queued, so large uploads can take a
while). That covers its own uploads, uploads from the command line found by a list
reload, and, after a page reload, any listed upload that isn't searchable. Once ready,
the row flashes and shows a "ready" pill for 5 s. A `404` (the upload was removed while
being checked) stops the checks and reloads the list. No checks run while the server or
database is down.

Who sets `searchableAt`. Every path runs the same check from `src/readiness.js`:
- Uploads from the page: the page's checks above.
- `npm run ingest`: after saving, it waits until the upload is searchable, sets
  `searchableAt`, and prints how long it took (no need for `npm run probe`).
- `npm run setup`: sets it for any complete upload that lacks it. The first run fills
  in the uploads saved before `searchableAt` existed (their delay, `searchableAt −
  uploadedAt`, is meaningless); later runs catch an upload whose ingest or page was
  closed before it was ready.

Until it is set, an upload is left out of "All uploads" and can't be ticked.

### `POST /api/uploads`

`multipart/form-data` with one field, `file`. Read by `multer` into memory; the file
is never written to disk. Its file name:
- is read as UTF-8 (multer's `defParamCharset`; its default, Latin-1, would garble
  "café.pdf");
- is cut to its last part, in case a browser sends a folder path;
- is put in composed Unicode form (NFC): macOS sends "é" as "e" plus an accent, which
  would otherwise slip past the duplicate check as a different name (done in
  `src/ingest.js`, so `npm run ingest` does it too);
- is limited to 255 characters (`400` `fileNameTooLong`).

The request stays open until the ingest has finished (all or nothing, as on the
command line).

`201` `upload` (complete, `searchable: false`)

| Status | Code | When |
|---|---|---|
| 400 | `noFile` | No `file` field. |
| 400 | `unexpectedFile` | A file in another field, or more than one file. |
| 400 | `invalidUpload` | A multipart body that can't be read (e.g. cut off). |
| 400 | `fileNameTooLong` | A file name over 255 characters. |
| 413 | `fileTooLarge` | Over 50 MB. |
| 415 | `unsupportedType` | Not `.txt`, `.md` or `.pdf`. |
| 409 | `duplicate` | A complete upload with this file name exists. |
| 409 | `uploadInProgress` | An ingest of this file name started under 10 minutes ago. |
| 422 | `scannedPdf` | The PDF has almost no text (scanned). Nothing is saved. |
| 422 | `unreadablePdf` | The PDF can't be parsed. |
| 422 | `noText` | No text after extraction. |

The page:
- Takes a file from the Upload button or dropped on the sidebar. A file dropped
  anywhere else does nothing (the browser would otherwise open it in place of the
  page); several files dropped at once are all refused.
- Uploads one file at a time: while one runs, the button reads "Uploading…" and is
  greyed out, and a file dropped meanwhile is refused with a notice (not queued).
  This holds per page only: two open browsers can still upload at once, which the
  server handles (each request is separate, and the same name is blocked).
- Checks before sending what it can, to save sending a file the server would refuse:
  the type, a duplicate name (against its list, in the same Unicode form, NFC), and
  the size against 50 MB (a constant in the page, which can't read `src/config.js`).
  The server's checks stay the real ones.
- Shows a progress card while the server saves the file, then "Saved (N chunks)" until
  the upload is ready; the new upload's group opens and its row flashes. A new upload
  isn't ticked: ticks change only when the user ticks.
- Shows every "this file wasn't uploaded" message in red: its own wording for the
  codes a user can run into (`duplicate`, `unsupportedType`, `scannedPdf`,
  `uploadInProgress`, `fileTooLarge`, `unreadablePdf`, `noText`, `fileNameTooLong`,
  `internal`, and an unreachable server), the server's message for any other code, and
  its refusals (several files, an upload already running, the server down). A new
  message replaces the previous one; each can be dismissed.
- Asks before the page is left or reloaded mid-upload (`beforeunload`). If the user
  leaves anyway, the server still finishes the ingest; only the progress card is lost.

## Questions

### `POST /api/ask`

```json
{ "question": "How long is an invitation valid?", "uploadIds": ["66f1...", "66f2..."] }
{ "question": "How long is an invitation valid?", "scope": "all" }
{ "question": "How long is an invitation valid?", "scope": "all", "rerank": false }
{ "question": "How long is an invitation valid?", "scope": "all", "search": "hybrid" }
```

- Exactly one of `uploadIds` (one or more) or `scope: "all"`. Neither is a 400, so a
  bug that sends an empty list can't quietly search everything.
- `uploadIds`: each must be a searchable upload. Exact search with
  `uploadId: { $in: [...] }`; the threshold for selected uploads. If the ticked
  uploads hold more than 10,000 chunks in total, approximate search instead (the Atlas
  documentation recommends exact search below 10,000 MDB docs); at this project's size
  that never happens.
- `scope: "all"`: approximate search over every searchable upload (`searchableAt` set);
  the "All uploads" threshold. It includes uploads added later.
- `rerank` (optional, milestone 9): by default the answer is reranked. Vector search
  fetches the top 50 chunks (`search.rerank.candidates` in `config.js`), the `$rerank`
  stage re-sorts them, and the top 10 go on, checked against the rerank thresholds
  (0.58). `false` answers from vector search alone, checked against the cosine
  thresholds (0.62), as before milestone 9. The page never sends it: a reranked
  answer already says what vector search alone would have sent (`withoutRerank`
  below), with no second request.
- `search` (optional, milestone 9): `"vector"` (the default) or `"hybrid"`. Hybrid
  search runs vector search and keyword search (Atlas Search on the chunks' text, with
  one-letter typo tolerance) on the same uploads, 50 chunks each; `$rankFusion` merges
  the two lists, each chunk once, and `$rerank` re-sorts the whole merged list (50 to
  100 chunks), checked against the rerank thresholds. Always reranked: the merged score
  depends only on the ranks, so no threshold can use it, and `rerank: false` with it is
  a 400. Not chosen: a keyword-only mode, whose scores have no fixed range.
- Stateless: no conversation history. Each question is answered on its own.

`200`, an answer:

```json
{
  "found": true,
  "reason": "answered",
  "parts": [
    { "text": "Owners and administrators can invite members.", "cites": [1] },
    { "text": "An invitation stays valid for 14 days.", "cites": [2] }
  ],
  "citations": [
    {
      "n": 1,
      "uploadId": "66f1...",
      "title": "Nimbus Admin Handbook",
      "fileName": "nimbus-admin-handbook.txt",
      "fileType": "txt",
      "section": null,
      "page": null,
      "chunkIndex": 0,
      "chunkCount": 7,
      "excerpt": "Every workspace has at least one owner. …"
    }
  ],
  "retrieval": {
    "search": "vector",
    "mode": "exact",
    "rerank": { "model": "rerank-3", "candidates": 18 },
    "uploadCount": 2,
    "chunksSearched": 18,
    "threshold": 0.58,
    "topScore": 0.91,
    "llmCalled": true,
    "hits": [
      { "score": 0.91, "vectorScore": 0.81, "vectorRank": 3, "keywordRank": null,
        "rerankRank": 1, "fusionScore": null, "uploadId": "66f1...",
        "title": "Nimbus Admin Handbook", "fileType": "txt", "section": null,
        "page": null, "chunkIndex": 1, "chunkCount": 7, "cited": 2 }
    ],
    "withoutRerank": {
      "threshold": 0.62,
      "topScore": 0.84,
      "llmCalled": true,
      "hits": [
        { "score": 0.84, "vectorScore": 0.84, "vectorRank": 1, "keywordRank": null,
          "rerankRank": 12, "fusionScore": null, "uploadId": "66f2...",
          "title": "Nimbus CLI Guide", "fileType": "md", "section": "Configuration",
          "page": null, "chunkIndex": 4, "chunkCount": 11, "cited": null }
      ]
    }
  }
}
```

- `parts`: the answer split where the LLM's citations fall; `cites` are citation
  numbers. The page puts a marker after each part, so it never parses `[1]` out of
  text (a literal "[1]" in an upload can't confuse it).
- Formatting: the LLM writes simple Markdown, and a list can be cut across several
  parts. So the page joins the parts into one text with a placeholder where each
  marker goes, escapes everything, then turns a small set of Markdown into formatting
  (paragraphs, bullet and numbered lists, fenced code blocks, `code`, **bold**,
  *italic*), and finally turns the placeholders into marker buttons. Anything else
  shows as plain text; headings, tables and links never appeared in the saved test
  answers. Bold may contain `code`. Not `_italic_`, since underscores start MongoDB
  names like `_id`. Code blocks (milestone 9) keep their lines and indentation as written, in a
  grey box that scrolls sideways instead of wrapping; no syntax colouring.
- Where the citation fields come from: `title`, `fileType` and `chunkCount` from
  `uploads`, joined to the search results with a `$lookup` stage at the end of the
  search pipeline; `section` and `chunkIndex` from the chunk.
- Where a citation points, by file type, and how the page shows it:
  - PDF: `page`, read from the section ("page 12"), shown as "PDF p. 12". It's the
    PDF's page number, not the printed one. No chapter, even when the chunk's prefix
    line names one.
  - Markdown: `section`, the heading path without the title, shown as
    "Installation › Windows". Text before the first heading below the title (stored
    with the file name or the title as its section) has `section: null` and is shown
    as "Opening text" (milestone 9; it showed no location before).
  - Plain text: `section` is null, so it's shown as "passage 2 of 7" (`chunkIndex`
    + 1 of `chunkCount`).

- `excerpt`: the cited chunk's text without its prefix line, i.e. up to the first
  blank line (a built-in citation quotes the whole chunk).
- `retrieval`: for the "How this was found" panel, shown on every answer, collapsed.
  `hits` are the chunks sent to the LLM (or that would have been), best first; `cited`
  is the citation number or null. Each hit has the same location fields as a citation,
  so the page labels it the same way. No chunk text, so it stays small.
  - `search`: the kind of search that found the chunks: `"vector"` or `"hybrid"`.
    `mode` is how the vector search ran: `"exact"` or `"approximate"`.
  - `rerank`: the model and `candidates`, how many chunks were actually reranked
    (vector: up to 50, fewer when the searched uploads hold fewer chunks; hybrid: the
    merged list, 50 to 100), or `null` when asked with `rerank: false`.
  - `score` (each hit), `topScore` and `threshold` are on the same scale: rerank
    scores when reranked, cosine otherwise. `vectorScore` is the cosine score, so a
    comparison can show it either way; `null` for a hybrid hit only keyword search
    found.
  - `vectorRank`, `keywordRank`: the hit's position in each list before reranking
    (1 = first), so the page can show how far reranking moved it ("vector #23 → #2").
    `null` when that list didn't find it; `keywordRank` is always `null` in vector
    search. In hybrid search they're copied from `$rankFusion`'s `scoreDetails`, whose
    format MongoDB doesn't guarantee, so the API keeps its own two fields.
  - `rerankRank`: the hit's position after reranking, among all the candidates (1 =
    first); `null` when not reranked.
  - `fusionScore`: hybrid search's merged score (Reciprocal Rank Fusion: each list
    adds 1 / (60 + rank), so about 0.009 to 0.033), `null` in vector search. It only
    reflects the ranks, so the page shows it as background, never as relevance.
  - `withoutRerank` (milestone 9): what vector search alone would have done, for the
    page's comparison. `hits` are vector search's own top 10 (`vectorRank` 1–10,
    best first), with `score` the cosine and `rerankRank` where reranking put each
    one (above 10: not sent). `threshold` is the cosine threshold (0.62), `topScore`
    the cosine of vector #1, and `llmCalled` whether that would have sent the question
    to the LLM rather than stopped it. Nothing in it went to the LLM; `cited` marks
    the passages the reranked answer cited. Taken from the same search: the 10 are
    among the 50 candidates fetched for reranking, so no second search runs. For
    ticked uploads (exact search) they match a search with `rerank: false`; in All
    uploads they're at least as close to the exact top 10, since vector search
    explores more candidates when fetching 50 (`numCandidates` 1,000 rather than
    200). `null` with `rerank: false` or hybrid search.

`200`, "not found in your uploads":

```json
{
  "found": false,
  "reason": "belowThreshold",
  "parts": [],
  "citations": [],
  "retrieval": { "llmCalled": false, "...": "..." }
}
```

`reason` is `belowThreshold` (LLM not called) or `noCitations` (the LLM found no answer
in the chunks). The page shows the same message for both; the reason only shows in
"How this was found". On a not-found answer for selected uploads, the page offers "Ask
all uploads instead".

| Status | Code | When |
|---|---|---|
| 400 | `missingQuestion` | Empty after trimming. |
| 400 | `questionTooLong` | Over 1,000 characters. |
| 400 | `missingScope` | Neither `uploadIds` nor `scope: "all"`, or an empty `uploadIds`. |
| 400 | `invalidScope` | Both, a `scope` other than `"all"`, or `uploadIds` not a list. |
| 400 | `invalidRerank` | `rerank` other than `true` or `false` (e.g. the string `"false"`). |
| 400 | `invalidSearch` | `search` other than `"vector"` or `"hybrid"`, or `"hybrid"` with `rerank: false`. |
| 400 | `invalidId` | A malformed id. |
| 400 | `invalidJson` | The body isn't valid JSON. |
| 413 | `requestTooLarge` | The body is over 100 KB (Express's default limit). |
| 404 | `uploadNotFound` | An id that isn't a complete upload. |
| 409 | `uploadNotReady` | An upload that isn't searchable yet. |
| 503 | `llmUnavailable` | The Anthropic API is overloaded or rate-limited. |
| 503 | `hybridUnavailable` | Hybrid search asked, but the keyword index is missing or still building (`npm run setup`, `npm run index-status`). Vector search still works. |
| 502 | `llmAccessDenied` | The Anthropic API, or a gateway in front of it (`ANTHROPIC_BASE_URL`), refused the server's key (401) or access (403). The server's settings need fixing; retrying won't help. |
| 502 | `llmModelNotFound` | The Anthropic API doesn't know the answer model (404): a misspelt `ANSWER_MODEL` in `.env`, or a model the key can't use. The message names the model. Retrying won't help. |
| 500 | `internal` | Anything else, including an LLM reply that was cut off. |

The page:
- Greys out the question box while nothing is ticked: no request is sent. A click on
  it highlights the picker. Enter asks, Shift+Enter starts a new line; a character
  count shows past 800 of the 1,000 allowed.
- Disables Ask while waiting, so a double click can't cost two LLM calls.
- Shows a failed question as the latest card, with its own wording for
  `llmUnavailable`, `llmAccessDenied`, `internal`, `uploadNotFound`, `uploadNotReady`
  and an unreachable server (the server's message for any other code) and a "Try
  again" button. The question stays in the box. The card goes when the next question
  is asked; failed questions aren't saved.
- After `uploadNotFound` or `uploadNotReady`, reloads the list (which unticks the
  upload, with a notice); after a network failure or a 5xx other than the answer
  service's (`llmUnavailable`, `llmAccessDenied`, `llmModelNotFound`), checks the
  connection.
- "How this was found" (milestone 9), on every answer and "not found" card: the search
  line names the reranking ("…then reranked by Voyage AI rerank-3 (50 candidates)").
  With `withoutRerank`, it opens with a summary ("Reranking replaced 4 of the 10
  passages", plus "Without it, this question would have been sent to the LLM" or
  "…stopped before the LLM" when the two verdicts differ), then two tabs, one table
  each: "With reranking" (open first; relevance, and each passage's position in
  vector search) and "Without reranking (vector search alone)" (similarity, and its
  position after reranking), each ending with its threshold verdict. The panel keeps
  the taller table's height, so switching tabs moves nothing. Passages in one list
  only are marked, with a note under the table only when it has a marked row (so no
  one looks for marks that aren't there): green in "With reranking"
  ("Highlighted: surfaced by reranking"), grey in "Without reranking" ("Shaded:
  dropped by reranking"). When every passage in a table comes from one upload, its
  title is in the heading ("Passage, all from …", with "(PDF)" for a PDF) and the
  rows show only the location ("p. 8"). Passages from the same page or section are told apart as parts ("PDF
  p. 9 (part 2)"), numbered in `chunkIndex` order among the passages the two tabs
  show (not out of all the page's chunks), the same in both tabs. Score bars span 0–1 for rerank
  scores and 0.45–0.95 for cosine scores, with the threshold as a red line. Answers
  saved before this (no `withoutRerank`, or no `rerank` before milestone 9) show one
  table, drawn on the scale their scores use; the saved format's version is
  unchanged, since it only gained fields.
- Escapes all text before showing it (see Formatting above): uploaded text and LLM
  output are untrusted.

## Page state that never reaches the server

- Ticks: in page memory only. They last while the page stays open; every page load
  starts with nothing ticked. Nothing is saved in the browser.
- Earlier questions: saved in the browser's `localStorage` (key `kb.history`), so they
  survive closing and reopening the page. Kept per browser and per address (localhost
  and the VM keep separate lists). Never sent to the server, and never sent to the
  LLM: each question is still answered on its own.
  - Saved: each finished answer as the API returned it (`parts`, `citations`,
    `retrieval`), with the question, the ticked uploads' ids and titles at the time,
    and when it was asked. Failed questions aren't saved.
  - A saved answer is a snapshot: it still shows if an upload it cites is removed
    later, since its titles and excerpts are stored with it.
  - The newest 50 are kept and older ones dropped (`localStorage` holds about 5 MB per
    address; an answer takes a few KB).
  - Stored with a format version. A page that finds another version starts an empty
    list rather than misreading it.
  - The section is labelled "Earlier questions" (not "in this session") and has a
    "Clear" link, since anyone using that browser sees the list. Clear asks first, then
    removes only what the list shows: the latest answer, still on screen, stays saved.
  - The latest answer is saved too, but listed only once the next question replaces
    it. After a page reload there is no latest card: every saved answer is in the
    list, which starts collapsed.
  - Times read "just now", "12 min ago", "3 h ago", then a date ("3 Oct", with the year
    if it isn't this year), updated without a redraw.
  - Before saving, the page reads the list again, so answers saved meanwhile by another
    tab are kept. If what is stored can't be read, the page keeps this visit's answers
    in memory instead.
  - If storage is blocked (e.g. a private window), the list just isn't kept.

## `src/` changes made in milestone 7

1. Error codes: `src/ingest.js` and the extractors throw an `UploadError`
   (`src/upload-error.js`) that carries a `code` (the codes above), so the API can tell
   a user mistake (4xx) from a server fault (500, a plain `Error`).
2. `src/search.js`: `uploadIds` (an array) instead of `uploadId`; "All uploads"
   filters on `searchableAt` instead of `status: 'complete'`; approximate search for
   ticked uploads over 10,000 chunks.
3. `src/answer.js`: the threshold by mode (selected uploads or all); returns `parts`,
   the citation fields above (`title`, `fileType` and `chunkCount` joined from
   `uploads` with `$lookup` in `src/search.js`, `page`, `excerpt`) and `retrieval`.
   Keeps `text` for `scripts/ask.js`. No data change: every field comes from what is
   stored.
4. `src/readiness.js`: the search-and-count check, moved from `tools/probe.js`, which
   then calls it. Also used by `scripts/ingest-file.js` (wait until searchable) and
   `scripts/setup-db.js` (fill in uploads that lack `searchableAt`). Must land
   together with change 2, or "All uploads" would find nothing.
5. `src/indexes.js`: the index definitions, moved from `scripts/setup-db.js`, plus the
   title index (`uploads_title_autocomplete`), and their status. At startup the server
   stops if the vector index is missing and only warns if the title index is.
   `src/title-search.js` queries the title index.
6. `src/config.js`: the title index name and title search settings, the upload size
   and file-name limits, and the threshold names (`oneUpload` became
   `selectedUploads`).
7. `scripts/ask.js` and `tools/search.js`: `--upload` may be given more than once.
8. Tests: 11 questions in `test/questions.json` have a `several` list of 2–3 uploads,
   with a "several" mode in both test runners (`tools/test-modes.js`), to check the
   threshold for selected uploads (PROJECT_PLAN.md, Findings: Several ticked uploads).

New in milestone 7: `server.js` at the root (`npm start`), its routes in `src/api/`
(including `GET /api/health`), and the dependencies `express` 5 and `multer` 2.
Milestone 8 added the page in `public/` (files in ARCHITECTURE.md) and one server
change: `src/title-search.js` remembers a working title index until the server stops
(see `GET /api/uploads/search`).

## Why it's built this way

The reasons behind PROJECT_PLAN.md's "Web page and API" decisions, settled during the
wireframe review (2026-10-02) and while building the page (2026-10-06 to 10-08).

- Picker: nothing ticked when the page opens, so asking is a deliberate choice. Not
  chosen: "All uploads" as the default. Ticks aren't kept across reloads, since the
  next visit may be about different uploads. Not chosen: remembering them in the
  browser (`localStorage`), first agreed, then dropped after trying it in the
  wireframe.
- Readiness: search and count checks "searchable", the real end result, using public
  features only. Not chosen: counting the generated embeddings (one step short of
  searchable, and their collection is found by a generated name whose format has
  changed before), or a fixed wait (no guarantee for large uploads). Ids rather than
  file names in the route: the page already has the ids, and they need no encoding in
  an address. Setup and the ingest command set `searchableAt` too, because "All
  uploads" only searches uploads that have it: without them, existing and
  command-line uploads would drop out, and the tests with them. Not chosen: the
  server checking unready uploads itself on each "All uploads" question (no gaps,
  but not needed for a demo).
- Health check: an unreachable database (e.g. after an IP change, which Atlas Network
  Access refuses) would otherwise look like every request failing with a vague 500.
- Answer formatting: a small Markdown subset keeps lists and code readable while
  everything else stays escaped. Not chosen: asking the LLM for plain text (a prompt
  change, which would need a full answer test run).
- List refresh on tab focus: uploads are shared and can come from the command line.
  Not chosen: refreshing on a timer.
- Uploads wait for the ingest: it is already all or nothing, the 280-page book took
  seconds, and Node waits up to 5 minutes by default. A background job is only worth
  building if a real upload gets close to that. One at a time keeps the page simple
  and stops two large PDFs racing for embedding. Not chosen: queueing a second file.
  Known limitation: Node runs JavaScript on one thread, so while pdf.js reads a large
  PDF, other requests wait (a few seconds for the 280-page book). Not chosen: reading
  PDFs in a worker thread, more than a demo needs.
- PDF citations give the page only (2026-10-05): the page number says clearly where a
  citation comes from, and the API stays simple. The chapter is only in the chunk's
  prefix line, and neither real PDF has chapter names. Not chosen: reading it from
  that line, or storing a `chapter` field (a schema change and a backfill).
- Answers as parts: the page never parses markers out of text. "How this was found"
  is shown to everyone, collapsed: it is the visible Vector Search showcase, and there
  are no logins or public access to protect. Not chosen: a debug-only mode.
- Earlier questions in `localStorage` (2026-10-03): wanted after closing and reopening
  the page. Not chosen: `sessionStorage` (lost when the tab closes), or a `questions`
  collection in Atlas (a server change; the parked analytics milestone may log
  questions there anyway).
- Standalone questions: follow-ups would need an extra LLM call to rewrite a question
  like "what about macOS?" before searching, would resend earlier answers, and would
  let earlier answers leak into a reply its citations don't support. Out of scope for
  a demo.
- `127.0.0.1`: Express otherwise listens on every network the computer is on, so
  anyone on the same Wi-Fi could upload files and spend LLM calls.
- Page code (milestone 8): plain JavaScript in the browser's own modules
  (`import`/`export`), so there is no build step. `format.js` holds the code that
  turns untrusted text into HTML, so it can be checked on its own. Not chosen: a
  framework, or a front-end test framework (both bigger than the page); the page was
  checked in a browser against the running server instead.
- Recovering from "down" by itself: the demo case is a restarted server or a fixed
  Atlas IP rule. Checking only while down costs nothing in normal use.
- Failed questions aren't saved: they hold nothing worth revisiting, and their
  question is still in the box. Keeping them in memory only would make the list
  differ after a reload.
- Error wording only for the codes a user can hit: the rest (`noFile`,
  `invalidJson`…) only come from a page bug or curl, and the server's messages read
  fine.
- Red for every upload that didn't happen, including the page's own refusals and an
  unticked upload: the user needs to notice. Not chosen: white notices for refusals.
- Few hints: no keyboard hints (they read as nagging); the search footer stays, since
  it names the Atlas feature behind the results. The selection row sits under "All
  uploads", where it is seen, not at the bottom of the sidebar.
- Icons: line icons (inline SVG) for the empty states; chevrons, close buttons and
  status marks stay characters (▸ ▾ × ✓ ? !), which take the page's colours, unlike
  emoji.
- "How this was found" ended with "Search mode: Vector." in milestone 8, where a
  mode switch might go. Milestone 9 dropped the line: the page has no mode switch
  (hybrid search made no difference, see `test/HYBRID.md`). Not chosen: naming
  milestone 9 on the page (the wireframe's "Keyword and Hybrid come with milestone
  9."), which advertises unfinished work in a demo.
- The comparison with vector search alone (milestone 9, 2026-10-28) is built from the
  reranked search itself: free, one request, and the same candidates on both sides.
  Not chosen: a checkbox that asks twice and shows two answers (two LLM calls, about
  $0.03 a question), a search-only route for the second list (a second search), or a
  choice of one way per question (no visible difference). Tabs rather than the two
  tables side by side, tried first: side by side, each table was so narrow that
  titles wrapped onto two or three lines and rows differed in height.
- Facets (milestone 10, 2026-11-03): counted by Atlas Search to showcase facets,
  although the page could count its own list; with a handful of uploads the counts
  are small, so they matter for a library of hundreds. Type and size, since the title
  already drives the A–Z groups and title search. Not chosen: the title's first letter
  (a stored copy of it, and the same as the groups), upload date (the test uploads
  fall in a few weeks, so one bucket), the list itself from `$search` (a new upload
  would vanish for a few seconds), one query for both rows (a ticked chip would turn
  the rest of its row to 0), counting in the browser when facets fail (more code for a
  case `npm run setup` prevents), counts that follow the typed words (built first,
  dropped on 2026-11-03: while typing "nim", PDF showed 0 and was greyed, though it
  would have filtered the list to its 2 PDFs).
