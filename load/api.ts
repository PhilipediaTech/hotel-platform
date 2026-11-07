// The API as the load tests measure it (T-101): the same server as `npm run dev`, without the
// file watcher and without per-request pretty-printed logs, which on one laptop cost more
// than the requests themselves. Warnings and errors still print. Stop `npm run dev` first
// (both use the API port).
//
//   npm run load:api

import { fileURLToPath } from 'node:url';

process.env.LOG_LEVEL = 'warn';
process.chdir(fileURLToPath(new URL('../apps/api/', import.meta.url)));
await import('../apps/api/src/server.ts');
