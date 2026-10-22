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
- PostgreSQL 18 installed natively (service `postgresql-x64-18`), binaries in `C:\Program Files\PostgreSQL\18\bin` (not on PATH yet). Databases: `hotel_dev`, `hotel_test`, `hotel_e2e`, `hotel_restore`.
- Node: repo pins 24.22.1 (`.nvmrc`); machine had 22.15.0 on 2026-10-22.

## Repo layout (as of T-002)

```text
apps/api        @hotel/api     Express 5 app
  src/server.ts                 HTTP entry (config → logger → app.listen, graceful shutdown)
  src/app.ts                    createApp({ config, logger, routes }) — middleware order per tab 2
  src/core/config.ts            env → Config (Zod)
  src/core/request-id.ts        X-Request-Id (req_<uuid>, or a safe incoming id)
  src/core/logger.ts            pino + pino-http (redaction, slim req/res serializers)
  src/core/errors.ts            AppError, notFoundHandler, errorHandler → error envelope
  src/test/helpers.ts           buildTestApp() with captured log lines, errorOf()
apps/web        @hotel/web     placeholder (T-006)
apps/site       @hotel/site    placeholder (V1.2)
packages/shared @hotel/shared  src/errors.ts: ERROR_HTTP_STATUS, ErrorCode, ErrorEnvelope
scripts/        commit-msg.mjs (+ test)
docs/           PROGRESS, HANDOFF, VERSIONS, adr/000–022
```

Root scripts: `npm run dev | build | lint | typecheck | format | format:check | test | check`. Hooks: pre-commit runs lint-staged (ESLint + Prettier); commit-msg checks the subject format.

**TypeScript conventions:** relative imports end in `.ts`; no enums, namespaces or constructor parameter properties (`erasableSyntaxOnly`) because Node runs the source directly. Use `as const` objects instead of enums. Tests use Vitest + Supertest against `createApp()`; pass extra routes via the `routes` option.

## Next step

T-003: Prisma 7.10.1 setup, first migration (tenancy + identity, including approved additions 1–8 from `docs/PROGRESS.md`), seed script. Needs PostgreSQL on PATH and `DATABASE_URL` for `hotel_dev` / `hotel_test`.
