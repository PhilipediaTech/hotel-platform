import { writeFileSync, readFileSync } from 'node:fs';
import { API_ROUTES, routeMetaSource } from '@hotel/shared';

// Writes packages/shared/src/api/route-meta.ts: each route's method, path and flags without
// its schemas, so the web client's bundle does not carry every route's Zod schemas (first
// load budget, T-091b). `npm run routes:meta` after adding or changing a route; a unit test
// fails while the file is out of date. `--check` only compares.

const target = new URL('../../../packages/shared/src/api/route-meta.ts', import.meta.url);
const source = routeMetaSource(API_ROUTES);

if (process.argv.includes('--check')) {
  const current = readFileSync(target, 'utf8');
  if (current !== source) {
    console.error('packages/shared/src/api/route-meta.ts is out of date: run npm run routes:meta');
    process.exit(1);
  }
  console.log('packages/shared/src/api/route-meta.ts is up to date.');
} else {
  writeFileSync(target, source);
  console.log('Wrote packages/shared/src/api/route-meta.ts');
}
