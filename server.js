// Starts the API server (milestone 7): connects to Atlas once, mounts the routes in
// src/api/, and serves the web page from public/ (milestone 8), so page and API share
// one address. Routes and formats are in docs/API_SPEC.md.
// Usage: npm start, or npm run dev to restart whenever a file changes.
// Listens on 127.0.0.1 (this computer only) unless HOST is set in .env; PORT
// defaults to 3000.

const path = require('path');
const express = require('express');
const config = require('./src/config');
const { connect } = require('./src/db');
const { searchIndexStatus } = require('./src/indexes');
const health = require('./src/api/health');
const uploads = require('./src/api/uploads');
const ask = require('./src/api/ask');
const { routeNotFound, handleErrors } = require('./src/api/errors');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 3000;

async function main() {
  // One connection for the whole server, shared by every request. Without the
  // database the server is no use, so it doesn't start; a connection lost later is
  // reported by GET /api/health instead.
  let client, db;
  try {
    ({ client, db } = await connect());
  } catch (err) {
    console.error(`Can't connect to Atlas: ${err.message}`);
    console.error('If your IP address has changed, add it in Atlas Network Access.');
    process.exit(1);
  }
  await checkSearchIndexes(db);

  // Every request passes through these in order (middleware), until one replies.
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/api', health(db));
  app.use('/api', uploads(db));
  app.use('/api', ask(db));
  app.use('/api', routeNotFound);   // no route above matched
  app.use(handleErrors);            // turns thrown errors into { error: { code, message } }

  const server = app.listen(PORT, HOST, (err) => {
    if (err) {
      console.error(`Can't listen on ${HOST}:${PORT}: ${err.message}`);
      process.exit(1);
    }
    console.log(`API server on http://${HOST}:${PORT}`);
    console.log(`Answer model: ${config.answer.model}`);
  });

  // Ctrl+C (SIGINT) or SIGTERM: stop taking requests, let the ones in progress finish
  // (an upload cut off midway couldn't clean up after itself), then close the database
  // connection so the process can exit. The message shows the stop was clean. A second
  // Ctrl+C stops at once.
  // On Windows, npm run dev's watcher ends the server with a hard kill instead (on
  // Ctrl+C and on each restart), so this doesn't run and no message shows. That's
  // harmless unless a request is in progress: Windows closes the connections, and
  // Atlas drops them.
  let stopping = false;
  const stop = async () => {
    if (stopping) {
      console.log('Stopped without waiting.');
      process.exit(1);
    }
    stopping = true;
    console.log('Stopping: finishing requests in progress (Ctrl+C again to stop now)…');
    await new Promise((resolve) => server.close(resolve));
    await client.close();
    console.log('Server stopped.');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// Without the vector index no question can be answered, so the server doesn't start.
// Without the title index only the picker's title search (the page filters its own list
// instead) and its Filter block are lost, and without the keyword index only hybrid
// search (vector answers still work), so for those it only warns. It also warns when an
// index lacks fields the code defines (an older definition), naming what they serve.
const LOST_WITHOUT = {
  [config.searchIndexes.title]: 'title search and the upload filter are off',
  [config.searchIndexes.keyword]: 'hybrid search is off',
};
const LOST_WITHOUT_FIELDS = {
  [config.searchIndexes.title]: 'the upload filter is off',
  [config.searchIndexes.keyword]: 'hybrid search may fail',
};

async function checkSearchIndexes(db) {
  for (const { index, exists, queryable, missingFields } of await searchIndexStatus(db)) {
    if (queryable && missingFields.length) {
      console.warn(`Warning: the search index ${index.name} doesn't index ${missingFields.join(', ')} yet, `
        + `so ${LOST_WITHOUT_FIELDS[index.name]}; run "npm run setup -- --update ${index.name}".`);
    }
    if (queryable) continue;
    const problem = exists ? 'is not queryable yet' : 'is missing';
    const fix = exists ? 'check "npm run index-status"' : 'run "npm run setup"';
    if (index.name === config.searchIndexes.vector) {
      console.error(`The vector search index ${index.name} ${problem}; ${fix}.`);
      process.exit(1);
    }
    console.warn(`Warning: the search index ${index.name} ${problem}, so ${LOST_WITHOUT[index.name]}; ${fix}.`);
  }
}

// main() is async, so an unexpected startup error (e.g. listing the search indexes
// fails) arrives as a rejected promise; print one readable line instead of a crash.
main().catch((err) => {
  console.error('The server could not start:', err.message);
  process.exit(1);
});
