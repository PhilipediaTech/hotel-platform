// NFR: front-desk app initial load < 300 KB gzipped. Run after `npm run build -w apps/web`.
// Counts what index.html loads up front: entry scripts, modulepreloads and stylesheets.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const BUDGET_BYTES = 300 * 1024;
const dist = new URL('../dist/', import.meta.url);

let html;
try {
  html = readFileSync(new URL('index.html', dist), 'utf8');
} catch {
  console.error('apps/web/dist/index.html not found. Run `npm run build -w apps/web` first.');
  process.exit(2);
}

const assets = new Set([html.length ? 'index.html' : '']);
for (const match of html.matchAll(/(?:src|href)="\/([^"]+\.(?:js|css))"/g)) {
  if (match[1]) assets.add(match[1]);
}
assets.delete('');

let total = 0;
for (const file of assets) {
  const size = gzipSync(readFileSync(new URL(file, dist))).length;
  total += size;
  console.log(`${(size / 1024).toFixed(1).padStart(7)} KB  ${file}`);
}
console.log(
  `${(total / 1024).toFixed(1).padStart(7)} KB  total (budget ${BUDGET_BYTES / 1024} KB)`,
);

if (total > BUDGET_BYTES) {
  console.error('✖ Initial load is over budget.');
  process.exit(1);
}
console.log('✔ Within budget.');
