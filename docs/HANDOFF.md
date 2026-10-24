# Handoff

Read this first in a fresh session, then `docs/PROGRESS.md`.

## What this is

Production hotel PMS SaaS built from "Hotel Management Platform — Master Specification v3.0" ([link](https://claude.ai/artifact/1RvubmsUXQrRo4kqaNMUkq), 11 tabs). Product owner and developer: Philip (MERN background; ships Express 5 + Prisma + PostgreSQL + Zod + Vitest + Playwright).

## Working rules (from Philip)

- Follow tab 6 (Implementation Backlog) ticket by ticket; re-read the cited PRD stories, schema models, API contracts and UI screens first.
- Every PRD acceptance criterion becomes at least one automated test. Read files before editing; never guess shapes.
- Commit after each ticket: `T-042: reservations create/modify/cancel` (enforced by the commit-msg hook).
- Keep `docs/PROGRESS.md` and this file current; new architectural decisions go in `docs/adr/` and must be reported to Philip.
- Stop and ask before: spending money or creating paid accounts; touching production; open ADRs 019–022 and the tax stack per state; deleting files; rewriting applied migrations; schema changes the spec doesn't cover; changing the stack or an accepted ADR.
- Commands given to Philip never contain placeholders.

## Environment

- Windows 11, Git Bash, VS Code. Repo at `C:\Users\USER\Desktop\hotel-platform`.
- Node 24.22.1 (matches `.nvmrc`).
- PostgreSQL 18 native (service `postgresql-x64-18`, binaries in `C:\Program Files\PostgreSQL\18\bin`). Databases `hotel_dev` (migrated + seeded), `hotel_test` (tests), `hotel_e2e`, `hotel_restore`.
- `.env` holds `DATABASE_URL`, `TEST_DATABASE_URL`, `E2E_DATABASE_URL` with Philip's password — never print it.

## Repo layout (as of T-006)

```text
prisma/
  schema.prisma                 Prisma models (tenancy + identity so far)
  migrations/                   SQL migrations; raw-SQL constraints appended by hand before applying
  seed.ts                       seed(db): demo org/property/departments/roles/users (idempotent)
prisma.config.ts                Prisma 7 config (schema, migrations, seed, datasource URL; loads .env)
apps/api        @hotel/api      Express 5 app
  src/server.ts                 HTTP entry (config → logger → db → app.listen, graceful shutdown)
  src/app.ts                    createApp({ config, logger, routes }) — middleware order per tab 2
  src/core/config.ts            env → Config (Zod)
  src/core/db.ts                createDb(url) (PrismaPg adapter), Db/DbClient types, pgErrorInfo()
  src/core/counters.ts          nextPropertyCounter(db|tx, propertyId, COUNTER.x)
  src/core/request-id.ts        X-Request-Id
  src/core/logger.ts            pino + pino-http (redaction, slim serializers)
  src/core/errors.ts            AppError, notFoundHandler, errorHandler → error envelope
  src/generated/prisma/         generated client (gitignored; `npm run db:generate`, also on postinstall)
  test/helpers.ts               buildTestApp(), errorOf(), TEST_CONFIG
  test/db.ts                    testDb(), resetDb(), expectViolation(), SQLSTATE
  test/factories.ts             makeOrganisation/Property/Role/User/Tenant
  test/global-setup.ts          prisma migrate deploy on TEST_DATABASE_URL
apps/web        @hotel/web      React 19 + Vite 8 PWA (staff and owner app)
  src/main.tsx                  QueryClientProvider → SessionContext → RouterProvider
  src/app/navigation.ts         NAV_ITEMS (screen + ticket per item), HOMES, homeFor/railItems/bottomBarItems
  src/app/routes.tsx            AppShell layout route; a placeholder route per screen until its ticket
  src/app/session.ts            ShellSession + PREVIEW_SESSION (replaced by /me in T-010/T-013)
  src/app/query-client.ts       TanStack Query defaults (shouldRetry)
  src/components/shell/         AppShell, TopBar, PropertyContext, offline/update banners
  src/components/ui/            shadcn/ui components (Button, DropdownMenu)
  src/i18n/                     i18next init + en.json (every UI string)
  src/index.css                 Tailwind 4 + design tokens (@theme)
  src/offline/                  useOnlineStatus (Dexie and the outbox arrive in T-093)
  scripts/check-bundle-size.mjs 300 KB gzipped initial-load budget
  scripts/generate-icons.mjs    placeholder PWA icons → public/icons
  vitest.config.ts              Vitest project "web" (jsdom)
apps/site       @hotel/site     placeholder (V1.2)
packages/shared @hotel/shared   errors.ts: ERROR_HTTP_STATUS, ErrorCode, ErrorEnvelope
docs/           PROGRESS, HANDOFF, VERSIONS, adr/000–023
```

Root scripts (`dev` runs api :4000 and web :5173 via `scripts/dev.mjs`; `check:size` builds web and checks the budget): `dev | check:size | build | lint | typecheck | format | format:check | test | check | db:generate | db:migrate | db:deploy | db:reset | seed`.

## Conventions

- **TypeScript (ADR-023):** relative imports end in `.ts`; no enums, namespaces or constructor parameter properties. Use `as const` objects.
- **Schema changes:** edit `schema.prisma` → `npx --no-install prisma migrate dev --create-only --name <name>` → append raw SQL (CHECKs, exclusion constraints, triggers) to the generated `migration.sql` → `npm run db:migrate` → confirm a second `--create-only` produces an empty migration (no drift) and delete it. Never edit an applied migration.
- **Prisma 7 refuses `migrate reset` from an AI agent** without Philip's explicit consent. Don't use it; tests use `migrate deploy` + truncation.
- **Tests:** `*.test.ts` = unit project; `*.int.test.ts` = integration project (real PostgreSQL, serial files, `resetDb()` in `beforeEach`). Constraint tests use `expectViolation(write, SQLSTATE.X, 'constraint_name')`.
- **DB errors:** map with `pgErrorInfo(err)`; never log the raw Postgres error (CHECK details contain the row).
- **Web:** every UI string goes in `src/i18n/en.json`; use the design tokens (`bg-surface`, `text-brand`, `text-critical`…), not raw palette colours; status is always text + icon, never colour alone. A new screen replaces its placeholder by adding a route at its `NAV_ITEMS` path. Component tests: `*.test.tsx` under `apps/web/src`.
- **Lockfile:** never regenerate it with `node_modules` or the old lock present (npm/cli#4828 drops platform bindings); follow the procedure in PROGRESS decisions. After any dependency change, `grep -c "node_modules/@rolldown/binding-" package-lock.json` must print 15.

## Next step

T-007 Zod → OpenAPI (`@asteasolutions/zod-to-openapi` 9.1.0) and the typed API client the web app will use. T-004 GitHub Actions is still blocked on a GitHub remote; when it lands, add `npm run check:size` and the schema-drift check to CI. T-005 needs paid accounts (stop).
