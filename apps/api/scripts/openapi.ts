// Writes apps/api/openapi.json from the route contracts in @hotel/shared.
// Usage: npm run openapi            (write)
//        npm run openapi -- --check (exit 1 if the committed file is stale)
// The committed copy makes every contract change visible in review; a unit test fails when
// it is out of date.
import { readFileSync, writeFileSync } from 'node:fs';
import { buildOpenApiDocument } from '../src/core/openapi.ts';

export const OPENAPI_FILE = new URL('../openapi.json', import.meta.url);

export function renderOpenApi(): string {
  return `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
}

function readCommitted(): string | undefined {
  try {
    return readFileSync(OPENAPI_FILE, 'utf8');
  } catch {
    return undefined;
  }
}

if (import.meta.main) {
  const rendered = renderOpenApi();
  if (process.argv.includes('--check')) {
    if (readCommitted() !== rendered) {
      console.error('apps/api/openapi.json is out of date. Run `npm run openapi`.');
      process.exit(1);
    }
    console.log('apps/api/openapi.json is up to date.');
  } else {
    writeFileSync(OPENAPI_FILE, rendered);
    console.log('Wrote apps/api/openapi.json');
  }
}
