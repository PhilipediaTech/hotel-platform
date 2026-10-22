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

## Repo layout (as of T-001)

```text
apps/api        @hotel/api     placeholder src/index.ts (T-002 builds it)
apps/web        @hotel/web     placeholder (T-006)
apps/site       @hotel/site    placeholder (V1.2)
packages/shared @hotel/shared  placeholder (T-002/T-007)
scripts/        commit-msg.mjs (+ test)
docs/           PROGRESS, HANDOFF, VERSIONS, adr/000–022
```

Root scripts: `npm run lint | typecheck | format | format:check | test | check`. Hooks: pre-commit runs lint-staged (ESLint + Prettier); commit-msg checks the subject format.

## Next step

T-002: Express app skeleton — requestId, Pino, helmet, CORS, error envelope (tab 4), `/health`. Middleware order is in tab 2 "Request lifecycle". Decide the API build/run approach (tsx in dev; tsc build to `apps/api/dist/server.js` per the Render blueprint).

Before T-003, get Philip's answer on spec issues 1–8 in `docs/PROGRESS.md` (schema additions).
