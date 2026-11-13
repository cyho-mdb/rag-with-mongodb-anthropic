// The web page (milestone 8): its state, the functions that draw the page from it, and
// the events that change it. Built from wireframe/index-green.html, and the Filter
// block (milestone 10) from wireframe/index-facets.html; the routes it calls, and how
// it reacts to their errors, are in docs/API_SPEC.md.
// Pattern: every change updates `state`, then calls render(), which redraws each area
// of the page from state. Simple, and fast enough at this size.

import { listUploads, checkHealth, searchTitles, countFacets, askQuestion, uploadFile, getUpload, ApiError, ServerUnreachable } from './api.js';
import { escapeHtml as esc, markWordStarts, answerHtml, locationLabel, timeAgo } from './format.js';

// While the server or the database is unreachable, check again this often.
const RETRY_MS = 5000;

// On the first load, every group of the picker starts open when there are at most this
// many uploads; with more, only the first group does.
const OPEN_ALL_UP_TO = 20;

// The picker's groups, by the first letter of the title (accents ignored).
const GROUPS = [
  { key: '#', label: '0–9 & other' },
  { key: 'AD', label: 'A – D', from: 'A', to: 'D' },
  { key: 'EH', label: 'E – H', from: 'E', to: 'H' },
  { key: 'IL', label: 'I – L', from: 'I', to: 'L' },
  { key: 'MP', label: 'M – P', from: 'M', to: 'P' },
  { key: 'QT', label: 'Q – T', from: 'Q', to: 'T' },
  { key: 'UZ', label: 'U – Z', from: 'U', to: 'Z' },
];

// The Filter block's rows and chips (milestone 10), keyed as the API takes them. `of`
// gives an upload's value, for filtering the page's own list. The sizes match
// facets.sizes in src/config.js, which the browser can't read.
const FACETS = [
  { key: 'type', label: 'Type', of: (u) => u.fileType, values: [
    { key: 'pdf', label: 'PDF' }, { key: 'md', label: 'MD' }, { key: 'txt', label: 'TXT' },
  ] },
  { key: 'size', label: 'Size', of: (u) => (u.chunkCount < 10 ? 'small' : u.chunkCount < 100 ? 'medium' : 'large'), values: [
    { key: 'small', label: 'Small', tip: 'Under 10 chunks (up to about 15,000 characters)' },
    { key: 'medium', label: 'Medium', tip: '10 to 99 chunks' },
    { key: 'large', label: 'Large', tip: '100 chunks or more, such as a book' },
  ] },
];

// Line icons for the empty states, drawn in the current text colour.
const icon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const ICONS = {
  folder: icon('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  chat: icon('<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9.5h8M8 12.5h5"/>'),
  tick: icon('<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>'),
  warn: icon('<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.2v.1"/>'),
};

// What the page says when a part is unreachable: the banner under the header, and the
// workspace's message.
const DOWN = {
  server: {
    banner: 'Can\'t reach the server. Is it running (<code>npm start</code>)? The page retries every few seconds.',
    workspace: 'The page can\'t reach the server, so questions can\'t be asked right now.',
  },
  database: {
    banner: 'The server can\'t reach the database. Check Atlas Network Access; your IP address may have changed. The page retries every few seconds.',
    workspace: 'The server can\'t reach the database, so questions can\'t be asked right now.',
  },
};

const state = {
  // 'checking' until the first health check answers, then 'ok', or the part that is
  // unreachable: 'server' or 'database'.
  connection: 'checking',
  uploads: null,          // from GET /api/uploads, sorted by title; null until it arrives
  listFailed: false,      // the list couldn't be loaded although the connection is fine
  open: new Set(),        // keys of the open groups
  // The picker's ticks, in page memory only: every page load starts with nothing ticked.
  all: false,             // "All uploads" ticked
  selected: new Set(),    // ids of the individually ticked uploads
  // The Filter block (milestone 10): the ticked chips per row, and the counts from
  // GET /api/uploads/facets ({ type: { pdf: 2, ... }, size: { ... } }), or null while
  // they are unavailable, which hides the block.
  filters: Object.fromEntries(FACETS.map((f) => [f.key, new Set()])),
  facets: null,
  // The latest question: { question, scope, askedAt, status, reply | error }. status is
  // 'loading', 'done' (reply is the API's answer) or 'error'. scope is { all: true } or
  // { uploads: [{ id, title }] }, kept as asked. Replaced as a whole on every change.
  // askedAt (a time in ms) also identifies the question in the saved list.
  latest: null,
  // Earlier questions: the answers saved in the browser, newest first, each
  // { question, scope, askedAt, reply }. The latest question's answer is saved too, but
  // only listed once the next question replaces it.
  history: [],            // loaded at startup
  historyOpen: false,     // the "Earlier questions" list is open
  openEarlier: null,      // askedAt of the earlier question shown in full, if any
  // The sidebar's upload messages, each { kind, name, text, hint, uploadId }. kind is
  // 'progress' (an upload running, always first), 'ok' (saved, until it is ready),
  // or 'error' (a file that wasn't uploaded). Replaced as a whole on every change.
  messages: [],
  justReady: new Set(),   // ids of uploads showing the "ready" pill for a few seconds
  flashing: new Set(),    // ids of picker rows to flash on the next drawing
};

const $ = (id) => document.getElementById(id);
const isDown = () => state.connection === 'server' || state.connection === 'database';
const byId = (id) => state.uploads?.find((u) => u.id === id);
const ready = () => (state.uploads ?? []).filter((u) => u.searchable);
const nothingSelected = () => !state.all && !state.selected.size;
const asking = () => state.latest?.status === 'loading';
const uploading = () => state.messages.some((m) => m.kind === 'progress');

// The Filter block's ticked chips: in a row any may match, and every row must.
const filtering = () => FACETS.some((f) => state.filters[f.key].size);
const passes = (u) => FACETS.every((f) => !state.filters[f.key].size || state.filters[f.key].has(f.of(u)));
const shown = () => (state.uploads ?? []).filter(passes);   // what the picker lists

// Splitting accents off (NFD) leaves the plain letter first: "É" becomes "E" + accent.
function groupOf(title) {
  const first = title.normalize('NFD').charAt(0).toUpperCase();
  return GROUPS.find((g) => g.from && first >= g.from && first <= g.to)?.key ?? '#';
}

// ---------- Connection and upload list ----------

let healthCheck = null;   // the check in progress, so two failed requests share one
let retryTimer = null;

// Asks GET /api/health which part is reachable, and redraws the dot and the banner.
// While a part is down, it checks again every RETRY_MS. When the connection becomes
// fine (on the first check, or after being down), it loads the upload list, which may
// have changed meanwhile.
function checkConnection() {
  healthCheck ??= (async () => {
    clearTimeout(retryTimer);
    const before = state.connection;
    state.connection = await checkHealth();
    healthCheck = null;
    if (isDown()) retryTimer = setTimeout(checkConnection, RETRY_MS);
    else if (before !== 'ok') await loadUploads();
    render();
  })();
  return healthCheck;
}

// Loads the upload list. If that fails, the health check tells a connection problem
// (the banner) from a failure of the list itself.
async function loadUploads() {
  try {
    const uploads = await listUploads();
    if (!state.uploads) openGroupsAtStart(uploads);
    const before = state.uploads;
    state.uploads = uploads;
    state.listFailed = false;
    // Ticks only for uploads that are still there and searchable, with a notice naming
    // the ones unticked (e.g. removed with npm run cleanup).
    const unticked = [...state.selected].filter((id) => !byId(id)?.searchable);
    for (const id of unticked) state.selected.delete(id);
    noticeUnticked(unticked.map((id) => before?.find((u) => u.id === id)).filter(Boolean));
    if (!ready().length) state.all = false;
    syncReadinessChecks();
    loadFacets();
  } catch (err) {
    console.error('Loading the upload list failed:', err);
    await checkConnection();
    state.listFailed = state.connection === 'ok';
  }
  render();
}

// The keys of the groups that hold at least one upload (of those the filter shows).
function usedGroups(uploads = shown()) {
  return GROUPS.filter((g) => uploads.some((u) => groupOf(u.title) === g.key)).map((g) => g.key);
}

function openGroupsAtStart(uploads) {
  const used = usedGroups(uploads);
  for (const key of uploads.length <= OPEN_ALL_UP_TO ? used : used.slice(0, 1)) state.open.add(key);
}

// ---------- Drawing ----------

function render() {
  renderConnection();
  renderMessages();
  renderFacets();
  renderAllRow();
  renderTree();
  renderSelBar();
  renderScope();
  renderWorkspace();
  renderHistory();
  renderAsk();
}

function renderConnection() {
  const [dot, label] = state.connection === 'checking' ? ['checking', 'Connecting…']
    : isDown() ? ['down', 'Disconnected']
    : ['', 'Connected'];
  $('connStatus').innerHTML = `<span class="dot ${dot}"></span>${label}`;
  $('banner').innerHTML = DOWN[state.connection]?.banner ?? '';
  $('banner').classList.toggle('show', isDown());
  $('uploadBtn').disabled = isDown() || uploading();
  $('uploadBtn').textContent = uploading() ? 'Uploading…' : '+ Upload';
  $('titleSearch').disabled = isDown();
}

let shownMessages = null;   // the state.messages on the page

// The upload messages under the Upload button. Redrawn only when they change, so the
// progress bar's animation isn't restarted by every redraw.
function renderMessages() {
  if (shownMessages === state.messages) return;
  shownMessages = state.messages;
  const el = $('uploadMsgs');
  el.innerHTML = state.messages.map((m, i) => {
    if (m.kind === 'progress') {
      return `<div class="msg"><div>Uploading <span class="name">${esc(m.name)}</span></div>
        <div class="hint">${esc(m.hint)}</div><div class="bar"><span></span></div></div>`;
    }
    return `<div class="msg ${m.kind}"><button class="close" data-msg="${i}" aria-label="Dismiss">×</button>
      <div><span class="name">${esc(m.name)}</span></div><div>${esc(m.text)}</div>
      ${m.hint ? `<div class="hint">${esc(m.hint)}</div>` : ''}</div>`;
  }).join('');
  el.style.marginBottom = state.messages.length ? '4px' : '0';
}

function renderAllRow() {
  const n = ready().length;
  const processing = (state.uploads?.length ?? 0) - n;
  // Like the rest of the picker, it can't be changed while a part is down; a tick
  // already there stays for when the connection is back.
  const off = !n || isDown();
  $('allBox').checked = state.all;
  $('allBox').disabled = off;
  $('allRow').classList.toggle('disabled', off);
  $('allCount').textContent = isDown() || !state.uploads ? '' : `${n}${processing ? ` ready, ${processing} processing` : ''}`;
  $('allRow').style.display = state.uploads?.length || isDown() ? '' : 'none';
}

function renderTree() {
  const tree = $('tree');
  if (isDown()) {
    tree.innerHTML = '<div class="empty-lib">Couldn\'t load uploads.</div>';
    return;
  }
  if (!state.uploads) {
    tree.innerHTML = `<div class="empty-lib">${state.listFailed
      ? 'Couldn\'t load uploads. Reload the page to try again.'
      : 'Loading uploads…'}</div>`;
    return;
  }
  if (!state.uploads.length) {
    tree.innerHTML = `<div class="empty-lib"><div class="big">${ICONS.folder}</div>No uploads yet.<br>Upload a .txt, .md or text-based PDF to start asking questions.</div>`;
    return;
  }

  // The list arrives sorted by title, so each group stays sorted.
  const groups = Object.fromEntries(GROUPS.map((g) => [g.key, []]));
  const listed = shown();
  for (const u of listed) groups[groupOf(u.title)].push(u);
  const note = !filtering() ? ''
    : listed.length ? `<div class="filter-note">Showing ${listed.length} of ${plural(state.uploads.length, 'upload')}</div>`
    : '<div class="filter-note">No uploads match the filter.</div>';

  tree.innerHTML = note + GROUPS.map((g) => {
    const items = groups[g.key];
    if (!items.length) {
      return `<button class="bucket-head empty" disabled><span class="chev">▸</span>${g.label}<span class="n">0</span></button>`;
    }
    const open = state.open.has(g.key);
    const nSel = items.filter((u) => state.selected.has(u.id)).length;
    const head = `<button class="bucket-head ${open ? 'open' : ''}" data-group="${g.key}" aria-expanded="${open}">
        <span class="chev">▸</span>${g.label}
        ${nSel ? `<span class="selcount" title="${nSel} selected">${nSel}</span>` : ''}
        <span class="n">${items.length}</span></button>`;
    return open ? `${head}<ul class="items">${items.map(itemRow).join('')}</ul>` : head;
  }).join('');
  state.flashing.clear();   // flashed once
}

// One upload in the picker. Until it is searchable it can't be ticked.
function itemRow(u) {
  const sel = state.selected.has(u.id);
  const tip = `${u.title}\n${u.fileName}\n${u.searchable ? `${u.chunkCount} chunks` : 'Being indexed for search'}`;
  const pill = !u.searchable ? '<span class="pill processing">processing…</span>'
    : state.justReady.has(u.id) ? '<span class="pill ready">ready</span>'
    : '';
  return `<li class="item ${sel ? 'sel' : ''} ${u.searchable ? '' : 'disabled'} ${state.flashing.has(u.id) ? 'flash' : ''}" data-id="${esc(u.id)}" title="${esc(tip)}">
      <input type="checkbox" ${sel ? 'checked' : ''} ${u.searchable ? '' : 'disabled'} tabindex="-1">
      <span class="type ${esc(u.fileType)}">${esc(u.fileType.toUpperCase())}</span>
      <span class="title">${esc(u.title)}</span>
      ${pill}
    </li>`;
}

// Under "All uploads": what is selected, with Clear while something is, and a toggle
// that collapses every group while any is open, or else expands them all. Ticked
// uploads the filter hides stay ticked, and are counted here: short, to fit the row,
// with the full sentence on hover.
function renderSelBar() {
  const n = state.selected.size;
  const hidden = [...state.selected].filter((id) => byId(id) && !passes(byId(id))).length;
  const hiddenNote = hidden
    ? `, <span title="${hidden} of them ${hidden === 1 ? 'is' : 'are'} hidden by the filter">${hidden} hidden</span>`
    : '';
  const label = state.all ? 'All uploads selected' : n ? `${n} selected${hiddenNote}` : 'Nothing selected';
  $('selBar').innerHTML = state.uploads?.length && !isDown()
    ? `<span>${label}</span><span class="spacer"></span>
       ${nothingSelected() ? '' : '<button class="linkbtn" id="clearSel">Clear</button>'}
       <button class="linkbtn" id="toggleGroups">${anyGroupOpen() ? 'Collapse all' : 'Expand all'}</button>`
    : '';
}

function anyGroupOpen() {
  return usedGroups().some((key) => state.open.has(key));
}

// What the next question will be asked of, as chips that can be removed.
function renderScope() {
  const el = $('scope');
  if (!state.uploads?.length || isDown()) {
    el.innerHTML = '';
  } else if (nothingSelected()) {
    el.innerHTML = 'Asking: <span class="none-sel">nothing selected yet</span>';
  } else if (state.all) {
    el.innerHTML = `Asking: <span class="chip all"><span>All uploads (${ready().length})</span>
      <button data-unselect="all" aria-label="Remove">×</button></span>`;
  } else {
    // In list order, so sorted by title.
    const chips = state.uploads.filter((u) => state.selected.has(u.id)).map((u) =>
      `<span class="chip" title="${esc(u.fileName)}"><span>${esc(u.title)}</span><button data-unselect="${esc(u.id)}" aria-label="Remove">×</button></span>`);
    el.innerHTML = `Asking: ${chips.join('')}`;
  }
}

let shownLatest = null;   // the state.latest whose card is on the page

// The top of the workspace: the latest question's card, or what to do next.
function renderWorkspace() {
  const el = $('latest');
  if (!isDown() && state.latest) {
    // Redrawn only when the latest question changes (a new state.latest), since a redraw
    // would close the sources and the "How this was found" panel the user opened.
    if (shownLatest !== state.latest) el.innerHTML = answerCard(state.latest);
    shownLatest = state.latest;
    return;
  }
  shownLatest = null;
  if (isDown()) {
    el.innerHTML = `<div class="ws-empty"><div class="big warn">${ICONS.warn}</div>${DOWN[state.connection].workspace}</div>`;
  } else if (state.uploads?.length === 0) {
    el.innerHTML = `<div class="ws-empty"><div class="big">${ICONS.chat}</div>Upload a file, then ask questions about it here.<br>Answers come only from your uploads, with sources.</div>`;
  } else if (state.uploads) {
    // Until the first answer, whatever is ticked: it stays put while ticking, rather than
    // changing under the user. The question box's placeholder says what to do next.
    el.innerHTML = `<div class="ws-empty"><div class="big">${ICONS.tick}</div>Answers come only from the uploads you choose, with sources.</div>`;
  } else {
    el.innerHTML = '';   // while the list loads
  }
}

let shownHistory = null;   // what renderHistory last drew, to skip redrawing the same

// Earlier questions, below the latest: one line each, opening to the full answer, one
// at a time. Redrawn only when what it shows changes, like the latest card; the times
// in it are updated in place (see updateTimes).
function renderHistory() {
  const el = $('history');
  const earlier = isDown() ? [] : state.history.filter((e) => e.askedAt !== state.latest?.askedAt);
  const drawn = [state.history, earlier.length, state.historyOpen, state.openEarlier];
  if (shownHistory && drawn.every((value, i) => value === shownHistory[i])) return;
  shownHistory = drawn;
  if (!earlier.length) {
    el.innerHTML = '';
    return;
  }
  const open = state.historyOpen;
  el.innerHTML = `<div class="history ${open ? 'open' : ''}">
      <div class="history-bar">
        <button class="history-head" data-action="toggleHistory" aria-expanded="${open}">
          <span class="chev">▸</span>Earlier questions<span class="hc">${earlier.length}</span></button>
        ${open ? '<button class="linkbtn" data-action="clearHistory" title="Remove the earlier questions saved in this browser">Clear</button>' : ''}
      </div>
      ${open ? `<div class="hist-list">${earlier.map(earlierRow).join('')}</div>` : ''}
    </div>`;
}

// One earlier question; the open one shows its answer below the line.
function earlierRow(e) {
  const open = state.openEarlier === e.askedAt;
  const [kind, mark, label] = e.reply.found
    ? ['ok', '✓', plural(e.reply.citations.length, 'source')]
    : ['nf', '?', 'Not found'];
  return `<div class="hist ${open ? 'open' : ''}" data-hist="${e.askedAt}">
      <button class="hist-head" data-action="toggleEarlier" aria-expanded="${open}">
        <span class="chev">▸</span><span class="st ${kind}" title="${label}">${mark}</span>
        <span class="hq" title="${esc(e.question)}">${esc(e.question)}</span>
        <span class="hm">${label} · ${agoHtml(e.askedAt)}</span>
      </button>
      ${open ? `<div class="hist-body ${e.reply.found ? '' : 'notfound'}" data-entry="${e.askedAt}">${answerBody(e)}</div>` : ''}
    </div>`;
}

// "12 min ago", marked so updateTimes can refresh it without redrawing.
function agoHtml(time) {
  return `<span class="ago" data-time="${time}">${timeAgo(time)}</span>`;
}

function updateTimes() {
  document.querySelectorAll('.ago').forEach((el) => { el.textContent = timeAgo(Number(el.dataset.time)); });
}

// Scrolls an opened section or row to the middle of the workspace. One taller than the
// workspace goes to the top instead, so its start stays visible.
function centerOn(el) {
  const workspace = document.querySelector('.workspace');
  const block = el.offsetHeight > workspace.clientHeight * 0.9 ? 'start' : 'center';
  el.scrollIntoView({ block, behavior: 'smooth' });
}

// With nothing ticked the box is greyed and read-only, not disabled: a disabled box
// ignores clicks, and a click should point the user to the picker.
function renderAsk() {
  const q = $('question');
  const off = !isDown() && ready().length > 0 && nothingSelected();
  q.disabled = isDown() || !ready().length;
  q.readOnly = off;
  q.placeholder = off
    ? 'Tick uploads in the list, or All uploads, to ask a question.'
    : 'Ask a question about your uploads…';
  $('askBtn').disabled = q.disabled || off || asking() || !q.value.trim();
  document.querySelector('.ask').classList.toggle('off', off);
  const length = q.value.length;
  $('charCount').textContent = length > 800 ? `${length} / 1000` : '';
}

// The question box grows with its text up to MAX_BOX_PX, then scrolls.
const MAX_BOX_PX = 220;

function grow() {
  const q = $('question');
  q.style.height = 'auto';
  q.style.height = `${Math.min(q.scrollHeight, MAX_BOX_PX)}px`;
  q.style.overflowY = q.scrollHeight > MAX_BOX_PX ? 'auto' : 'hidden';
  renderAsk();
}

// Briefly highlights the picker, when a question can't be asked because nothing is
// ticked.
function nudgePicker() {
  const sidebar = $('sidebar');
  sidebar.classList.remove('nudge');
  void sidebar.offsetWidth;   // restarts the animation on repeated clicks
  sidebar.classList.add('nudge');
}

// ---------- Picker ----------

// Ticks or unticks one upload. Individual ticks and "All uploads" don't mix, so ticking
// one unticks "All uploads". Its group opens, so the tick can be seen.
function toggleUpload(id) {
  const u = byId(id);
  if (!u?.searchable) return;
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  state.all = false;
  state.open.add(groupOf(u.title));
  render();
}

function toggleAll() {
  if (!ready().length || isDown()) return;
  state.all = !state.all;
  state.selected.clear();
  render();
}

function clearSelection() {
  state.all = false;
  state.selected.clear();
  render();
}

// ---------- Title search ----------
// Suggestions come from GET /api/uploads/search (Atlas Search autocomplete on titles and
// file names, typos allowed, best match first), asked once typing pauses. If the title
// index is missing (503 titleSearchUnavailable) or the request fails, the page filters
// its own list instead.

const SEARCH_DELAY_MS = 200;
const MAX_SUGGESTIONS = 8;

let searchTimer = null;
let searchSeq = 0;          // numbers the requests, so a late reply to an older query is dropped
let suggestions = null;     // { query, uploads, local } for the dropdown; null when there are none
let activeSuggestion = -1;  // the row the arrow keys point at
// The dropdown is open: from a click into the search box (or typing) until Esc or a
// click elsewhere. Before anything is typed, it shows only the footer.
let suggestOpen = false;

// Words as the server splits them: at spaces, hyphens, underscores and dots.
function searchWords(text) {
  return text.toLowerCase().split(/[\s\-_.]+/).filter(Boolean);
}

// The typed words that count: one letter matches nothing on the server, so suggestions
// start at two letters, and a one-letter word is skipped while a longer one is there.
function typedWords(query) {
  return searchWords(query).filter((w) => w.length > 1);
}

function onSearchInput() {
  clearTimeout(searchTimer);
  activeSuggestion = -1;
  const query = $('titleSearch').value.trim();
  if (!typedWords(query).length) {
    searchSeq++;   // a reply still on its way is no longer wanted
    suggestions = null;
    renderSuggest();
    return;
  }
  searchTimer = setTimeout(() => runSearch(query), SEARCH_DELAY_MS);
}

async function runSearch(query) {
  const seq = ++searchSeq;
  let uploads;
  let local = false;
  try {
    uploads = await searchTitles(query, filterParams());
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'titleSearchUnavailable')) {
      console.error('Title search failed:', err);
      checkConnection();
    }
    uploads = filterLocally(query);
    local = true;
  }
  if (seq !== searchSeq) return;
  suggestions = { query, uploads, local };
  renderSuggest();
}

// The fallback: every typed word must start a word of the title or the file name, as on
// the server, but without typos. In list order (by title), and only what the filter shows.
function filterLocally(query) {
  const typed = typedWords(query);
  return shown().filter((u) => {
    const own = searchWords(`${u.title} ${u.fileName}`);
    return typed.every((t) => own.some((w) => w.startsWith(t)));
  }).slice(0, MAX_SUGGESTIONS);
}

function renderSuggest() {
  const box = $('suggest');
  if (!suggestOpen) {
    box.classList.remove('show');
    return;
  }
  const { query = '', uploads = [], local = false } = suggestions ?? {};
  const words = typedWords(query);
  const rows = uploads.map((found, i) => {
    const u = byId(found.id) ?? found;   // the page's copy has the latest searchable
    return `<div class="row ${i === activeSuggestion ? 'active' : ''}" data-id="${esc(u.id)}">
        <input type="checkbox" ${state.selected.has(u.id) ? 'checked' : ''} ${u.searchable ? '' : 'disabled'} tabindex="-1">
        <div><div class="t">${markWordStarts(u.title, words)}${u.searchable ? '' : ' <span class="pill processing">processing…</span>'}</div>
        <div class="f">${esc(u.fileName)}</div></div></div>`;
  }).join('');
  const source = (local
    ? 'Filtered in the browser: title search is unavailable'
    : 'Atlas Search · autocomplete on title and file name') + (filtering() ? ' · filtered' : '');
  const none = suggestions && !rows
    ? `<div class="none">No titles or file names match "${esc(query)}"${filtering() ? ' with this filter' : ''}.</div>`
    : '';
  box.innerHTML = `${rows}${none}<div class="foot">${source}</div>`;
  box.classList.add('show');
}

// Ticks a suggestion in the picker, and flashes its row there. An upload added since
// the list was loaded (e.g. from the command line) needs the list reloaded first.
async function pickSuggestion(id) {
  if (!byId(id)) await loadUploads();
  if (!byId(id)?.searchable) return;
  toggleUpload(id);
  const row = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  row?.classList.add('flash');
  row?.scrollIntoView({ block: 'nearest' });
  renderSuggest();
}

// ---------- Filter (facets) ----------
// The Filter block above the title search (milestone 10): a row of chips for Type and
// one for Size, each with its count from GET /api/uploads/facets (Atlas Search facets).
// The counts are for the whole library and don't follow the typed words: the list
// below isn't narrowed by them, so a chip greyed for 0 matches would block a filter
// that works on the list. Each row's counts apply the other row's chips, not its own,
// so a second value can still be added. Ticked chips filter the page's own list and
// the suggestions; ticks and "All uploads" stay as they are. If the counts can't be
// had, the chips are cleared and the block is hidden until the list next reloads.

let facetSeq = 0;   // numbers the requests, so a late reply to an older one is dropped

// The ticked chips as the API takes them: { type: ['pdf'], size: [] }.
function filterParams() {
  return Object.fromEntries(FACETS.map((f) => [f.key, [...state.filters[f.key]]]));
}

// Asks for the counts, with the ticked chips.
async function loadFacets() {
  const seq = ++facetSeq;
  let facets = null;
  try {
    facets = await countFacets(filterParams());
  } catch (err) {
    if (!(err instanceof ApiError && err.code === 'facetsUnavailable')) {
      console.error('Loading the filter counts failed:', err);
      checkConnection();
    }
  }
  if (seq !== facetSeq) return;
  const lost = !facets && filtering();
  state.facets = facets;
  if (lost) {
    FACETS.forEach((f) => state.filters[f.key].clear());
    render();
  } else {
    renderFacets();
  }
}

function renderFacets() {
  const el = $('facets');
  if (isDown() || !state.uploads?.length || !state.facets) {
    el.innerHTML = '';
    return;
  }
  const rows = FACETS.map((f) => {
    const chips = f.values.map((v) => {
      const n = state.facets[f.key][v.key] ?? 0;
      const on = state.filters[f.key].has(v.key);
      return `<button class="fchip ${on ? 'on' : ''}" data-facet="${f.key}" data-value="${v.key}" aria-pressed="${on}"
          ${n || on ? '' : 'disabled'} ${v.tip ? `title="${esc(v.tip)}"` : ''}>${v.label}<span class="n">${n}</span></button>`;
    }).join('');
    return `<div class="frow"><span class="fname">${f.label}</span><div class="fchips">${chips}</div></div>`;
  }).join('');
  el.innerHTML = `<div class="fhead"><span>Filter</span>
      ${filtering() ? '<button class="linkbtn" data-action="clearFilter">Clear filter</button>' : ''}</div>${rows}`;
}

// Ticking a chip opens every group with a match, since a filtered list is short;
// unticking or clearing leaves the groups as they are. The counts and any open
// suggestions are asked again with the new chips.
function changeFilter(change) {
  change();
  if (filtering()) shown().forEach((u) => state.open.add(groupOf(u.title)));
  render();
  loadFacets();
  if (suggestOpen && suggestions) runSearch(suggestions.query);
}

function toggleChip(facet, value) {
  const set = state.filters[facet];
  changeFilter(() => (set.has(value) ? set.delete(value) : set.add(value)));
}

function clearFilter() {
  changeFilter(() => FACETS.forEach((f) => state.filters[f.key].clear()));
}

// ---------- Uploads ----------
// One file at a time, from the Upload button or dropped on the sidebar. The page checks
// what it can before sending (type, duplicate name, size), to save sending a file the
// server would refuse; the server's checks stay the real ones. The request stays open
// until the file is saved (docs/API_SPEC.md: POST /api/uploads).

const UPLOAD_TYPES = ['.txt', '.md', '.pdf'];
// The same limit as upload.maxMegabytes in src/config.js, which the browser can't read.
const MAX_UPLOAD_MB = 50;

// Page wording for the upload errors a user can run into. Any other code shows the
// server's own message.
const UPLOAD_ERRORS = {
  duplicate: { text: 'This file name has already been uploaded.', hint: 'Uploads can\'t be replaced in the app. Rename the file to upload it as a new one.' },
  unsupportedType: { text: 'This file type isn\'t supported.', hint: 'Upload a .txt, .md or text-based PDF.' },
  scannedPdf: { text: 'This PDF has almost no text: it looks scanned.', hint: 'Scanned PDFs and images aren\'t supported (no OCR). Nothing was saved.' },
  uploadInProgress: { text: 'A file with this name is being uploaded right now.', hint: 'Try again in a few minutes.' },
  fileTooLarge: { text: `This file is too large (limit ${MAX_UPLOAD_MB} MB).`, hint: '' },
  unreadablePdf: { text: 'This PDF can\'t be read: it may be damaged or protected.', hint: 'Nothing was saved.' },
  noText: { text: 'No text was found in this file.', hint: 'Nothing was saved.' },
  fileNameTooLong: { text: 'This file name is too long (limit 255 characters).', hint: 'Rename the file to upload it.' },
  internal: { text: 'Something went wrong on the server.', hint: 'Try again.' },
};

// Adds a message below the running upload, if any. A new error replaces the previous
// one; "Saved" messages stay until their upload is ready.
function addMessage(message) {
  const progress = state.messages.filter((m) => m.kind === 'progress');
  const saved = state.messages.filter((m) => m.kind === 'ok');
  state.messages = [...progress, message, ...saved];
}

function uploadError(name, code) {
  addMessage({ kind: 'error', name, ...UPLOAD_ERRORS[code] });
  render();
}

// A file the page didn't send, for a reason other than the file itself. Red like the
// errors: the user needs to notice that their file wasn't uploaded.
function notice(name, text, hint = '') {
  addMessage({ kind: 'error', name, text, hint });
  render();
}

// Ticked uploads that were removed (or, set by hand, aren't searchable any more) have
// just been unticked. Red too: what the next question is asked of has changed. The
// caller redraws.
function noticeUnticked(uploads) {
  if (uploads.length === 1) {
    addMessage({ kind: 'error', name: uploads[0].fileName, text: 'This upload is no longer available, so it was unticked.', hint: '' });
  } else if (uploads.length) {
    addMessage({ kind: 'error', name: `${uploads.length} uploads`, text: 'These ticked uploads are no longer available, so they were unticked.', hint: uploads.map((u) => u.title).join(', ') });
  }
}

// Uploads one file: the checks, the progress card while the server saves it, then
// "Saved" and the new upload in the picker, "processing…" until it is ready.
async function startUpload(file) {
  if (uploading()) return notice(file.name, 'Wait for the current upload to finish.', 'Files upload one at a time.');
  if (isDown()) return notice(file.name, 'The server can\'t be reached, so the file wasn\'t uploaded.', 'Try again once the page reconnects.');
  // The name as the server will store it: composed Unicode form (NFC), so "é" typed
  // two ways is one name, as in the server's duplicate check.
  const name = file.name.normalize('NFC').trim();
  const ext = (name.match(/\.[^.]+$/)?.[0] ?? '').toLowerCase();
  if (!UPLOAD_TYPES.includes(ext)) return uploadError(name, 'unsupportedType');
  if (state.uploads?.some((u) => u.fileName === name)) return uploadError(name, 'duplicate');
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) return uploadError(name, 'fileTooLarge');

  const hint = ext === '.pdf' ? 'Reading pages and saving chunks. A long PDF can take a minute.' : 'Saving chunks…';
  // Errors from earlier go; "Saved" messages stay.
  state.messages = [{ kind: 'progress', name, hint }, ...state.messages.filter((m) => m.kind === 'ok')];
  render();

  let upload;
  try {
    upload = await uploadFile(file);
  } catch (err) {
    console.error('Uploading failed:', err);
    state.messages = state.messages.filter((m) => m.kind !== 'progress');
    if (err instanceof ServerUnreachable) {
      addMessage({ kind: 'error', name, text: 'The upload didn\'t finish: the server can\'t be reached.', hint: 'Once it\'s back, check the list; if the file isn\'t there, upload it again.' });
    } else {
      addMessage({ kind: 'error', name, ...(UPLOAD_ERRORS[err.code] ?? { text: err.message, hint: '' }) });
    }
    if (!(err instanceof ApiError) || err.status >= 500) checkConnection();
    render();
    return;
  }

  state.messages = [
    { kind: 'ok', name, uploadId: upload.id, text: `Saved (${plural(upload.chunkCount, 'chunk')}).`, hint: 'It can be searched in a few seconds; until then it shows "processing…".' },
    ...state.messages.filter((m) => m.kind !== 'progress'),
  ];
  state.open.add(groupOf(upload.title));
  state.flashing.add(upload.id);
  await loadUploads();   // shows it in the picker, sorted, and starts its readiness checks
}

// ---------- Readiness ----------
// A new upload can't be searched until Atlas has embedded its chunks, a few seconds
// after it is saved. For each listed upload that isn't searchable, the page asks
// GET /api/uploads/:id, which runs the server's readiness check: every 3 s for the
// first minute, then every 15 s (very large uploads can take a while), with no limit.
// This covers uploads from this page, from the command line, and those still
// processing when the page was reloaded.

const READY_FAST_MS = 3000;
const READY_FAST_FOR_MS = 60 * 1000;   // counted from when this page starts checking
const READY_SLOW_MS = 15 * 1000;
const READY_PILL_MS = 5000;            // how long the "ready" pill shows

const readinessChecks = new Map();     // upload id → { since, timer }

// After the list is (re)loaded: starts checks for unready uploads, and stops those for
// uploads that are gone or became searchable meanwhile (e.g. set by npm run ingest).
function syncReadinessChecks() {
  for (const id of readinessChecks.keys()) {
    const u = byId(id);
    if (u && !u.searchable) continue;
    stopReadinessCheck(id);
    if (u) showReady(u);
    else dropSavedMessage(id);
  }
  for (const u of state.uploads) {
    if (u.searchable || readinessChecks.has(u.id)) continue;
    readinessChecks.set(u.id, { since: Date.now(), timer: setTimeout(() => checkReady(u.id), READY_FAST_MS) });
  }
}

function stopReadinessCheck(id) {
  clearTimeout(readinessChecks.get(id)?.timer);
  readinessChecks.delete(id);
}

async function checkReady(id) {
  const check = readinessChecks.get(id);
  if (!check) return;
  // While a part is down, the health checks run instead; checking resumes after.
  if (!isDown()) {
    try {
      const upload = await getUpload(id);
      if (!readinessChecks.has(id)) return;   // stopped meanwhile by a list reload
      if (upload.searchable) {
        stopReadinessCheck(id);
        state.uploads = state.uploads.map((u) => (u.id === id ? upload : u));
        showReady(upload);
        render();
        loadFacets();   // by now the title index counts it too
        return;
      }
    } catch (err) {
      if (!readinessChecks.has(id)) return;
      // Removed while being checked (e.g. by npm run cleanup): stop, and reload the list.
      if (err instanceof ApiError && err.code === 'uploadNotFound') {
        stopReadinessCheck(id);
        dropSavedMessage(id);
        loadUploads();
        return;
      }
      console.error('Checking whether an upload is ready failed:', err);
      if (!(err instanceof ApiError) || err.status >= 500) checkConnection();
    }
  }
  const fast = Date.now() - check.since < READY_FAST_FOR_MS;
  check.timer = setTimeout(() => checkReady(id), fast ? READY_FAST_MS : READY_SLOW_MS);
}

// An upload just became searchable: its "Saved" message goes, its row flashes and shows
// "ready" for a few seconds. The caller redraws.
function showReady(u) {
  dropSavedMessage(u.id);
  state.flashing.add(u.id);
  state.justReady.add(u.id);
  setTimeout(() => {
    state.justReady.delete(u.id);
    renderTree();
  }, READY_PILL_MS);
}

function dropSavedMessage(id) {
  if (state.messages.some((m) => m.uploadId === id)) {
    state.messages = state.messages.filter((m) => m.uploadId !== id);
  }
}

// ---------- Questions ----------

// Page wording for the errors POST /api/ask can return (docs/API_SPEC.md: Questions). Any
// other code shows the server's own message.
const ASK_ERRORS = {
  llmUnavailable: 'The answer service is busy right now. Try again in a minute.',
  llmAccessDenied: 'The answer service didn\'t accept this server\'s key. Check the API key in the server\'s .env file.',
  internal: 'Something went wrong on the server while answering.',
  uploadNotFound: 'One of the ticked uploads no longer exists, so it has been unticked.',
  uploadNotReady: 'One of the ticked uploads is still being processed. Try again once it shows as ready.',
};

// 5xx errors from the answer service (the LLM), not the server or the database, so
// they don't start a connection check.
const LLM_ERRORS = ['llmUnavailable', 'llmAccessDenied', 'llmModelNotFound'];

// Asks the question in the box (or `question`) of the ticked uploads, or of all uploads
// when `all` is set ("Ask all uploads instead"). One question at a time: Ask stays
// disabled until the reply, so a double click can't cost two LLM calls. A failed
// question stays in the box, for Try again.
async function ask({ question, all = false } = {}) {
  const text = (question ?? $('question').value).trim();
  if (!text || asking() || isDown()) return;
  if (!all && nothingSelected()) {
    nudgePicker();
    return;
  }
  // The titles are kept with the question, so its card can name them later.
  const scope = all || state.all
    ? { all: true }
    : { uploads: state.uploads.filter((u) => state.selected.has(u.id)).map(({ id, title }) => ({ id, title })) };
  state.latest = { question: text, scope, askedAt: Date.now(), status: 'loading' };
  state.historyOpen = false;   // a new question gets the attention
  state.openEarlier = null;
  render();
  document.querySelector('.workspace').scrollTo({ top: 0, behavior: 'smooth' });

  try {
    const reply = await askQuestion(text, scope.all ? null : scope.uploads.map((u) => u.id));
    state.latest = { ...state.latest, status: 'done', reply };
    addToHistory({ question: text, scope, askedAt: state.latest.askedAt, reply });
    // Cleared only if the box still holds this question, not one typed meanwhile.
    const box = $('question');
    if (box.value.trim() === text) {
      box.value = '';
      grow();
    }
  } catch (err) {
    console.error('Asking failed:', err);
    state.latest = { ...state.latest, status: 'error', error: err };
    if (err instanceof ApiError && ['uploadNotFound', 'uploadNotReady'].includes(err.code)) {
      loadUploads();   // unticks what is gone
    } else if (!(err instanceof ApiError) || (err.status >= 500 && !LLM_ERRORS.includes(err.code))) {
      checkConnection();   // the server or the database may be down
    }
  }
  render();
}

function askErrorText(err) {
  if (err instanceof ServerUnreachable) return 'The server couldn\'t be reached.';
  if (err instanceof ApiError) return ASK_ERRORS[err.code] ?? err.message;
  return 'Something went wrong in the page.';   // a bug; the details are in the console
}

// ---------- Earlier questions, saved in the browser ----------
// Each finished answer is saved in localStorage as the API returned it, with the
// question, the uploads it was asked of and when (docs/API_SPEC.md: Page state that never
// reaches the server). Kept per browser and address, never sent to the server or the
// LLM. Failed questions aren't saved. If storage is blocked (e.g. a private window),
// the list just isn't kept.

const HISTORY_KEY = 'kb.history';
// Saved with the list. A page that finds another version starts an empty list rather
// than misreading it; change it when the saved format changes.
const HISTORY_VERSION = 1;
// localStorage holds about 5 MB per address, and an answer takes a few KB.
const HISTORY_MAX = 50;

// The saved list, [] when nothing is saved, or null when it can't be read: storage is
// blocked, or holds something unreadable or of another version.
function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (raw === null) return [];
    const saved = JSON.parse(raw);
    return saved?.version === HISTORY_VERSION && Array.isArray(saved.entries) ? saved.entries : null;
  } catch {
    return null;
  }
}

function saveHistory() {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify({ version: HISTORY_VERSION, entries: state.history }));
  } catch (err) {
    console.warn('Earlier questions could not be saved:', err.message);
  }
}

// Adds an answer at the top, keeping the newest HISTORY_MAX. The saved list is read
// again first, so answers saved meanwhile by another tab of the page are kept; if it
// can't be read, the list in page memory is used, so this visit's answers still show.
function addToHistory(entry) {
  state.history = [entry, ...(loadHistory() ?? state.history)].slice(0, HISTORY_MAX);
  saveHistory();
}

// Clears what "Earlier questions" lists. The latest answer, still on screen, stays
// saved, so it is still there after a reload.
function clearHistory() {
  if (!confirm('Remove the earlier questions saved in this browser?')) return;
  state.history = state.history.filter((e) => e.askedAt === state.latest?.askedAt);
  state.historyOpen = false;
  state.openEarlier = null;
  if (state.history.length) {
    saveHistory();
  } else {
    try {
      localStorage.removeItem(HISTORY_KEY);
    } catch {
      // blocked: there was nothing saved
    }
  }
  render();
}

// The question with this askedAt: the latest, or a saved one.
function entryAt(askedAt) {
  return state.latest?.askedAt === askedAt ? state.latest : state.history.find((e) => e.askedAt === askedAt);
}

// ---------- Answer card ----------

function scopeLabel(scope) {
  if (scope.all) return 'All uploads';
  const titles = scope.uploads.map((u) => u.title);
  return titles.length <= 2 ? titles.join(', ') : `${titles[0]} and ${titles.length - 1} more`;
}

// data-entry (askedAt) tells the buttons inside which question they belong to.
function answerCard(a) {
  const kind = a.status === 'error' ? 'err' : a.reply && !a.reply.found ? 'notfound' : '';
  return `<div class="card ${kind}" data-entry="${a.askedAt}"><div class="q">${esc(a.question)}</div>${answerBody(a)}</div>`;
}

// Everything below the question: waiting, failed, not found, or the answer. Saved
// questions have no status, only a reply.
function answerBody(a) {
  const askedOf = `Asked of: ${esc(scopeLabel(a.scope))}`;
  if (a.status === 'loading') {
    const what = a.scope.all ? 'all uploads' : plural(a.scope.uploads.length, 'upload');
    return `<div class="meta">${askedOf}</div>
      <div class="loading-row"><div class="spinner"></div>Searching ${what} and writing an answer… usually a few seconds</div>
      <div class="skel" style="width:92%"></div><div class="skel" style="width:78%"></div><div class="skel" style="width:60%"></div>`;
  }
  if (a.status === 'error') {
    const inBox = $('question').value.trim() === a.question ? ' Your question is still in the box above.' : '';
    return `<div class="meta">${askedOf}</div>
      <div class="nf-title"><span class="nf-icon">!</span>Couldn't get an answer</div>
      <div class="err-text">${esc(askErrorText(a.error))}${inBox}</div>
      <div class="card-actions"><button class="btn" data-action="retry">Try again</button></div>`;
  }

  const r = a.reply;
  const meta = `<div class="meta">${askedOf} · ${agoHtml(a.askedAt)}</div>`;
  if (!r.found) {
    // The same message for both reasons; the reason shows in "How this was found".
    const why = r.reason === 'belowThreshold'
      ? `Nothing in ${a.scope.all ? 'your uploads' : 'the selected uploads'} is close to this question.`
      : 'Passages on this topic were found, but none of them answers the question.';
    const askAll = a.scope.all ? '' : '<div class="card-actions"><button class="btn" data-action="askAll">Ask all uploads instead</button></div>';
    return `${meta}<div class="nf-title"><span class="nf-icon">?</span>Not found in your uploads</div>
      <div class="answer">${why}</div>${askAll}${detailsHtml(r.retrieval)}`;
  }

  const sources = r.citations.map((c) => {
    const where = locationLabel(c);
    return `<div class="src" data-src="${c.n}">
      <div class="src-head" data-action="toggleSource"><span class="chev">▸</span><span class="n">${c.n}</span>
        <span class="t">${esc(c.title)}${where ? ` <span class="w">· ${esc(where)}</span>` : ''}</span><span class="f">${esc(c.fileName)}</span></div>
      <div class="excerpt">${esc(c.excerpt)}</div></div>`;
  }).join('');
  return `${meta}<div class="answer">${answerHtml(r.parts)}</div>
    <div class="sources"><h3>Sources</h3>${sources}</div>${detailsHtml(r.retrieval)}`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// Score bars span these scores; the red line on each marks its threshold. Rerank scores
// run from 0 to 1 (unrelated passages sit near 0.25); cosine scores fill a narrow band,
// which their bar spreads out.
const SCORE_BARS = {
  rerank: { min: 0, max: 1 },
  cosine: { min: 0.45, max: 0.95 },
};

// "How this was found", collapsed: how the search ran, what the threshold decided,
// whether the LLM cited anything, and the passages sent to it (or that would have
// been), with their scores. A reranked answer compares its passages, in two tabs, with
// the ones vector search alone would have sent (withoutRerank, milestone 9).
// Answers saved earlier lack withoutRerank (and those from before milestone 9 lack
// rerank too, with cosine scores), so they show one table.
function detailsHtml(r) {
  const w = r.withoutRerank;
  const n = r.hits.length;
  const passages = plural(n, 'passage');
  const mode = r.mode.charAt(0).toUpperCase() + r.mode.slice(1);
  const reranked = r.rerank
    ? `, then reranked by Voyage AI ${esc(r.rerank.model)} (${plural(r.rerank.candidates, 'candidate')})` : '';
  const cited = r.hits.filter((h) => h.cited).length;
  const answer = !r.llmCalled ? ''
    : `<dt>Answer</dt><dd>${cited ? `cites ${cited} of the ${passages}` : 'no passage cited, so it counts as not found'}</dd>`;
  const facts = (threshold) => `<dl class="facts">
      <dt>Search</dt><dd>${esc(mode)} vector search over ${plural(r.uploadCount, 'upload')} (${plural(r.chunksSearched, 'chunk')})${reranked}</dd>
      ${threshold}${answer}
    </dl>`;
  const panel = (body) => `<details class="details"><summary>How this was found</summary><div class="box">${body}</div></details>`;

  if (!w || !n) {
    let verdict;
    if (r.topScore === null) verdict = 'no passages found, so the LLM was not called';
    else if (r.llmCalled) verdict = `best match ${r.topScore.toFixed(3)} ≥ ${r.threshold}, so the top ${passages} went to the LLM`;
    else verdict = `best match ${r.topScore.toFixed(3)} < ${r.threshold}, so the LLM was not called`;
    const bar = r.rerank ? SCORE_BARS.rerank : SCORE_BARS.cosine;
    return panel(`${facts(`<dt>Threshold</dt><dd>${verdict}</dd>`)}${hitsTable(r.hits, { bar, threshold: r.threshold, parts: partNumbers(r.hits) })}`);
  }
  // Both tabs number the parts of a page or section the same way.
  const parts = partNumbers([...r.hits, ...w.hits]);

  // Passages in one list only: in the reranked top n but below vector search's own top,
  // or the other way round.
  const vectorOnly = (h) => h.rerankRank > n;
  const rerankOnly = (h) => h.vectorRank > w.hits.length;
  const replaced = r.hits.filter(rerankOnly).length;
  let summary;
  if (replaced) summary = `Reranking replaced ${replaced} of the ${passages}.`;
  else if (r.hits.every((h, i) => h.vectorRank === i + 1)) summary = `Reranking kept the same ${passages}, in the same order.`;
  else summary = `Reranking kept the same ${passages}, in a different order.`;
  if (r.llmCalled !== w.llmCalled) {
    summary += r.llmCalled
      ? ' Without it, this question would have been stopped before the LLM.'
      : ' Without it, this question would have been sent to the LLM.';
  }

  const rerankVerdict = r.llmCalled
    ? `Best relevance ${r.topScore.toFixed(3)} ≥ ${r.threshold}: sent to the LLM.`
    : `Best relevance ${r.topScore.toFixed(3)} < ${r.threshold}: stopped, so the LLM was not called.`;
  const vectorVerdict = w.llmCalled
    ? `Best similarity ${w.topScore.toFixed(3)} ≥ ${w.threshold}: would have been sent to the LLM.`
    : `Best similarity ${w.topScore.toFixed(3)} < ${w.threshold}: would have been stopped.`;

  // Two tabs, one list each; the first is open. Both panels sit in the same grid cell,
  // so the box keeps the taller one's height and switching never moves the page. Each
  // note on the marked rows shows only when a row is marked, so no one looks for them.
  return panel(`<div class="compare-summary">${summary}</div>
    ${facts('')}
    <div class="tabs" role="tablist">
      <button class="tab on" role="tab" aria-selected="true" data-action="showTab" data-tab="0">With reranking</button>
      <button class="tab" role="tab" aria-selected="false" data-action="showTab" data-tab="1">Without reranking (vector search alone)</button>
    </div>
    <div class="tab-panels">
      <div class="tab-panel on" role="tabpanel">
        ${hitsTable(r.hits, {
          bar: SCORE_BARS.rerank, threshold: r.threshold, parts, scoreHead: 'Relevance',
          otherHead: 'Vector Search', other: (h) => `#${h.vectorRank}`,
          mark: (h) => (rerankOnly(h) ? 'surfaced' : ''),
        })}
        <div class="verdict">${rerankVerdict}</div>
        ${replaced ? '<div class="legend">Highlighted: surfaced by reranking.</div>' : ''}</div>
      <div class="tab-panel" role="tabpanel">
        ${hitsTable(w.hits, {
          bar: SCORE_BARS.cosine, threshold: w.threshold, parts, scoreHead: 'Similarity',
          otherHead: 'Reranked', other: (h) => `#${h.rerankRank}`,
          mark: (h) => (vectorOnly(h) ? 'dropped' : ''),
        })}
        <div class="verdict">${vectorVerdict}</div>
        ${w.hits.some(vectorOnly) ? '<div class="legend">Shaded: dropped by reranking.</div>' : ''}</div>
    </div>
    <div class="legend">Relevance (reranking) and similarity (vector search) are different scales.</div>`);
}

// Switches the comparison to the clicked tab. The card isn't redrawn while it's shown,
// so the tab stays as clicked, like an opened source.
function showTab(button) {
  const box = button.closest('.box');
  const index = Number(button.dataset.tab);
  box.querySelectorAll('.tab').forEach((tab, i) => {
    tab.classList.toggle('on', i === index);
    tab.setAttribute('aria-selected', String(i === index));
  });
  box.querySelectorAll('.tab-panel').forEach((panel, i) => panel.classList.toggle('on', i === index));
}

// The passages as a table: position, score with its bar (the red line marks the
// threshold), title and location, and the citation. With headings, a fourth column
// (`other`) gives each passage's position in the other list, and `mark` names a class
// for the passages missing from it ('surfaced' or 'dropped'); when every passage comes
// from one upload, its title (and "PDF") is in the heading instead of on each row.
// `parts` (from partNumbers) tells apart passages from the same page or section.
function hitsTable(hits, { bar, threshold, parts, scoreHead, otherHead, other, mark }) {
  if (!hits.length) return '';
  const pct = (score) => Math.max(0, Math.min(100, ((score - bar.min) / (bar.max - bar.min)) * 100));
  const oneUpload = Boolean(scoreHead) && hits.every((h) => h.uploadId === hits[0].uploadId);
  const pdf = hits[0].fileType === 'pdf';
  const passageHead = oneUpload ? `Passage, all from ${esc(hits[0].title)}${pdf ? ' (PDF)' : ''}` : 'Passage';
  const head = scoreHead
    ? `<tr><th></th><th>${scoreHead}</th><th>${passageHead}</th><th class="other">${otherHead}</th></tr>` : '';
  const rows = hits.map((h, i) => {
    // "PDF p. 8" becomes "p. 8" when the heading already says PDF.
    const where = oneUpload && pdf && h.page ? `p. ${h.page}` : locationLabel(h);
    const part = parts.get(`${h.uploadId}:${h.chunkIndex}`);
    const place = where && part ? `${where} (part ${part})` : where;
    // A passage with no location (a PDF passage without a page, which ingest never
    // stores) keeps the title, even in a one-upload table, so the row isn't empty.
    const name = oneUpload && place ? esc(place)
      : `${esc(h.title)}${place ? ` <span class="where">· ${esc(place)}</span>` : ''}`;
    const classes = [h.score < threshold ? 'low' : '', mark?.(h) ?? ''].filter(Boolean).join(' ');
    return `<tr class="${classes}"><td class="rank">${i + 1}</td>
      <td class="score">${h.score.toFixed(2)}<span class="scorebar"><span style="width:${pct(h.score)}%"></span><i style="left:${pct(threshold)}%"></i></span></td>
      <td>${name}${h.cited ? ` <span class="citedtag">cited [${h.cited}]</span>` : ''}</td>
      ${other ? `<td class="other">${other(h)}</td>` : ''}</tr>`;
  }).join('');
  return `<table class="hits">${head}${rows}</table>`;
}

// Part numbers for passages that share a page or section (one long PDF page, or a
// Markdown section split into several chunks), which would otherwise look the same:
// numbered in chunkIndex order (their order in the upload), among the passages shown.
// A map from "uploadId:chunkIndex" to the part number; locations with one passage
// shown get none. Plain-text passages are already told apart ("passage 2 of 7").
function partNumbers(hits) {
  const byPlace = new Map();   // "uploadId|location" -> { uploadId, chunkIndexes }
  for (const h of hits) {
    const where = locationLabel(h);
    if (!where) continue;
    const key = `${h.uploadId}|${where}`;
    if (!byPlace.has(key)) byPlace.set(key, { uploadId: h.uploadId, chunkIndexes: new Set() });
    byPlace.get(key).chunkIndexes.add(h.chunkIndex);
  }
  const parts = new Map();
  for (const { uploadId, chunkIndexes } of byPlace.values()) {
    if (chunkIndexes.size < 2) continue;
    [...chunkIndexes].sort((a, b) => a - b)
      .forEach((chunkIndex, i) => parts.set(`${uploadId}:${chunkIndex}`, i + 1));
  }
  return parts;
}

// ---------- Events ----------

$('tree').addEventListener('click', (e) => {
  const head = e.target.closest('.bucket-head[data-group]');
  if (head) {
    const key = head.dataset.group;
    state.open.has(key) ? state.open.delete(key) : state.open.add(key);
    renderTree();
    renderSelBar();   // "Collapse all" or "Expand all"
    return;
  }
  const item = e.target.closest('.item');
  if (item) toggleUpload(item.dataset.id);
});

$('allRow').addEventListener('click', toggleAll);

// Chips: mousedown keeps the focus where it is, so a click doesn't close the
// suggestions (the search box closes them when it loses focus); click toggles, from the
// mouse or the keyboard.
$('facets').addEventListener('mousedown', (e) => {
  if (e.target.closest('button')) e.preventDefault();
});
$('facets').addEventListener('click', (e) => {
  if (e.target.closest('[data-action="clearFilter"]')) return clearFilter();
  const chip = e.target.closest('.fchip');
  if (chip && !chip.disabled) toggleChip(chip.dataset.facet, chip.dataset.value);
});

$('selBar').addEventListener('click', (e) => {
  if (e.target.id === 'clearSel') clearSelection();
  if (e.target.id === 'toggleGroups') {
    if (anyGroupOpen()) state.open.clear();
    else usedGroups().forEach((key) => state.open.add(key));
    renderTree();
    renderSelBar();
  }
});

$('scope').addEventListener('click', (e) => {
  const id = e.target.closest('[data-unselect]')?.dataset.unselect;
  if (id === 'all') clearSelection();
  else if (id) {
    state.selected.delete(id);
    render();
  }
});

// A click on the greyed question box briefly highlights the picker.
document.querySelector('.ask').addEventListener('click', () => {
  if (!isDown() && ready().length && nothingSelected()) nudgePicker();
});

$('question').addEventListener('input', grow);
$('question').addEventListener('keydown', (e) => {
  // Enter asks, Shift+Enter starts a new line. Not while an input method (e.g. for
  // Chinese or Japanese) is still composing a character.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    ask();
  }
});
$('askBtn').addEventListener('click', () => ask());
window.addEventListener('resize', grow);

// Clicks in the latest card and in the earlier questions. A button inside an answer
// finds its question through the nearest data-entry (the card, or an opened earlier
// question).
$('answers').addEventListener('click', (e) => {
  // A citation marker opens and highlights its source, in the same answer.
  const cite = e.target.closest('.cite');
  if (cite) {
    const answer = cite.closest('[data-entry]');
    const src = answer.querySelector(`.src[data-src="${cite.dataset.n}"]`);
    answer.querySelectorAll('.src.hl').forEach((s) => s.classList.remove('hl'));
    src?.classList.add('open', 'hl');
    src?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  const button = e.target.closest('[data-action]');
  if (!button) return;
  const entry = () => entryAt(Number(button.closest('[data-entry]').dataset.entry));
  switch (button.dataset.action) {
    case 'toggleSource':
      button.closest('.src').classList.toggle('open');
      break;
    case 'showTab':
      showTab(button);
      break;
    case 'retry':
      ask({ question: entry().question });
      break;
    case 'askAll':
      ask({ question: entry().question, all: true });
      break;
    case 'toggleHistory':
      state.historyOpen = !state.historyOpen;
      state.openEarlier = null;
      renderHistory();
      if (state.historyOpen) centerOn($('history'));
      break;
    case 'toggleEarlier': {
      const askedAt = Number(button.closest('[data-hist]').dataset.hist);
      state.openEarlier = state.openEarlier === askedAt ? null : askedAt;   // one open at a time
      renderHistory();
      centerOn(document.querySelector(`.hist[data-hist="${askedAt}"]`));
      break;
    }
    case 'clearHistory':
      clearHistory();
      break;
  }
});

// Times like "12 min ago" move on without a redraw.
setInterval(updateTimes, 30 * 1000);

const search = $('titleSearch');
// Opens the dropdown; a click is needed besides focus for a box still focused after Esc.
function openSuggest() {
  suggestOpen = true;
  renderSuggest();
}
search.addEventListener('focus', openSuggest);
search.addEventListener('click', openSuggest);
search.addEventListener('input', () => {
  suggestOpen = true;
  onSearchInput();
});
// Leaving the box closes the dropdown. Clicks in the dropdown keep the focus in the box
// (see below), so ticking a suggestion doesn't close it.
search.addEventListener('blur', () => {
  suggestOpen = false;
  renderSuggest();
});
search.addEventListener('keydown', (e) => {
  const rows = suggestions?.uploads ?? [];
  if (e.key === 'ArrowDown' && rows.length) {
    activeSuggestion = Math.min(rows.length - 1, activeSuggestion + 1);
    renderSuggest();
    e.preventDefault();
  } else if (e.key === 'ArrowUp' && rows.length) {
    activeSuggestion = Math.max(0, activeSuggestion - 1);
    renderSuggest();
    e.preventDefault();
  } else if (e.key === 'Enter' && rows[activeSuggestion]) {
    pickSuggestion(rows[activeSuggestion].id);
    e.preventDefault();
  } else if (e.key === 'Escape') {
    search.value = '';
    suggestOpen = false;
    onSearchInput();
  }
});
// preventDefault keeps the focus in the search box, so the dropdown stays open for
// ticking several suggestions, and typing can continue.
$('suggest').addEventListener('mousedown', (e) => {
  e.preventDefault();
  const row = e.target.closest('.row');
  if (row) pickSuggestion(row.dataset.id);
});

$('uploadBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';   // so choosing the same file again still fires "change"
  if (file) startUpload(file);
});

// Drag and drop: the sidebar takes a dropped file. A file dropped anywhere else does
// nothing; by default the browser would open it in the tab, replacing the page.
const sidebar = $('sidebar');
const draggingFiles = (e) => e.dataTransfer?.types.includes('Files');
window.addEventListener('dragover', (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  const onSidebar = sidebar.contains(e.target);
  e.dataTransfer.dropEffect = onSidebar ? 'copy' : 'none';
  sidebar.classList.toggle('dragover', onSidebar);
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget || !sidebar.contains(e.relatedTarget)) sidebar.classList.remove('dragover');
});
window.addEventListener('drop', (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  sidebar.classList.remove('dragover');
  if (!sidebar.contains(e.target)) return;
  const files = e.dataTransfer.files;
  if (files.length > 1) notice(`${files.length} files`, 'Drop one file at a time.', 'Files upload one at a time.');
  else if (files.length) startUpload(files[0]);
});

$('uploadMsgs').addEventListener('click', (e) => {
  const i = e.target.closest('[data-msg]')?.dataset.msg;
  if (i === undefined) return;
  state.messages = state.messages.filter((m, j) => j !== Number(i));
  renderMessages();
});

// Leaving or reloading mid-upload: the browser asks first. The server finishes the
// ingest anyway; only the progress card would be lost.
window.addEventListener('beforeunload', (e) => {
  if (uploading()) e.preventDefault();
});

// Uploads are shared and can come from the command line, so the list is reloaded when
// the page's tab or window regains focus. While a part is down, the health checks
// reload it instead.
window.addEventListener('focus', () => {
  if (state.connection === 'ok') loadUploads();
});

state.history = loadHistory() ?? [];
render();
checkConnection();
