# ADR-023: Run TypeScript natively on Node 24 (type stripping)

- **Status:** Proposed — add to the Decision Log (tab 10)
- **Date:** 2026-10-24

## Context

The API needs a dev runner, a production build (`node apps/api/dist/server.js`, Render blueprint) and a way to consume `@hotel/shared` and the Prisma 7 generated client, which is TypeScript source. Options were tsx/nodemon in dev with a bundler or a separate build of `packages/shared`, or Node 24's built-in type stripping.

## Decision

- Node 24 runs `.ts` files directly. Dev is `node --watch src/server.ts`; no tsx, ts-node or nodemon.
- Relative imports end in `.ts`. `tsc` (with `rewriteRelativeImportExtensions`) builds `apps/api/dist` and rewrites them to `.js`.
- `@hotel/shared` exports its TypeScript source and is loaded as-is at runtime.
- Prisma generates its client into `apps/api/src/generated/prisma` as `.ts` with `.ts` imports.
- `erasableSyntaxOnly` is on: no `enum`, `namespace` or constructor parameter properties. Use `as const` objects and explicit fields.

## Consequences

- One fewer dev dependency, and the code that runs is the code that is written.
- Requires Node ≥ 22.18 (pinned 24.22.1 in `.nvmrc`, `engines` and Render).
- A small set of TypeScript features is off-limits; ESLint and `tsc` catch them.
- If Node's type stripping changes, the fallback is tsx in dev and a bundler for production, with no code changes beyond imports.
