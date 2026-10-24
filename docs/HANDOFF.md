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

## Repo layout (as of T-003)

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
apps/web        @hotel/web      placeholder (T-006)
apps/site       @hotel/site     placeholder (V1.2)
packages/shared @hotel/shared   errors.ts: ERROR_HTTP_STATUS, ErrorCode, ErrorEnvelope
docs/           PROGRESS, HANDOFF, VERSIONS, adr/000–023
```

Root scripts: `dev | build | lint | typecheck | format | format:check | test | check | db:generate | db:migrate | db:deploy | db:reset | seed`.

## Conventions

- **TypeScript (ADR-023):** relative imports end in `.ts`; no enums, namespaces or constructor parameter properties. Use `as const` objects.
- **Schema changes:** edit `schema.prisma` → `npx --no-install prisma migrate dev --create-only --name <name>` → append raw SQL (CHECKs, exclusion constraints, triggers) to the generated `migration.sql` → `npm run db:migrate` → confirm a second `--create-only` produces an empty migration (no drift) and delete it. Never edit an applied migration.
- **Prisma 7 refuses `migrate reset` from an AI agent** without Philip's explicit consent. Don't use it; tests use `migrate deploy` + truncation.
- **Tests:** `*.test.ts` = unit project; `*.int.test.ts` = integration project (real PostgreSQL, serial files, `resetDb()` in `beforeEach`). Constraint tests use `expectViolation(write, SQLSTATE.X, 'constraint_name')`.
- **DB errors:** map with `pgErrorInfo(err)`; never log the raw Postgres error (CHECK details contain the row).

## Next step

T-004 GitHub Actions — blocked on (1) a GitHub remote and (2) Philip's OK to regenerate `package-lock.json` (missing rolldown platform packages; see PROGRESS known gaps). Workflow per tab 9 plus: create `hotel_test` with `TEST_DATABASE_URL`, run `prisma migrate deploy`, and add a schema-drift check. T-005 needs paid accounts (stop). T-006 (PWA shell) and T-007 (OpenAPI) can go ahead without either.
