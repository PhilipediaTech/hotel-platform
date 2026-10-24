# Progress

Source of truth: [Master Specification v3.0](https://claude.ai/artifact/1RvubmsUXQrRo4kqaNMUkq). Authority when tabs conflict: Decision Log > Master PRD > Architecture > Schema / API > Strategy.

## Status

| Item             | Value                                                                        |
| ---------------- | ---------------------------------------------------------------------------- |
| Current sprint   | S0 (V0 Engineering foundation)                                               |
| Last ticket done | T-003                                                                        |
| Next ticket      | T-006 PWA shell (T-004 waits for the GitHub remote; T-005 for paid accounts) |
| Tests passing    | 105 (58 unit, 47 integration on `hotel_test`; 8 files)                       |

## Tickets

| Ticket                                                            | Status                                  | Tests                                                        | Commit       |
| ----------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------ | ------------ |
| T-001 Monorepo, TypeScript strict, ESLint, Prettier, commit hooks | Done                                    | 15 (commit-message rule)                                     | `T-001: ...` |
| T-002 Express skeleton                                            | Done                                    | 41 (app, config, shared error codes)                         | `T-002: ...` |
| T-003 Prisma setup, first migration (tenancy + identity), seed    | Done                                    | 49 (schema constraints, counters, seed, pgErrorInfo, config) | `T-003: ...` |
| T-004 GitHub Actions                                              | Needs a GitHub remote (Philip)          |                                                              |              |
| T-005 Staging on Render + Cloudflare                              | **Stop — needs paid accounts (Philip)** |                                                              |              |
| T-006 React + Vite PWA shell                                      | Pending                                 |                                                              |              |
| T-007 Zod → OpenAPI                                               | Pending                                 |                                                              |              |

## Decisions taken in the build

<!-- newest last -->

| Date       | Decision                                                                                                                                                                                                                                                                                                                            | Why                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 2026-10-22 | TypeScript pinned at 6.0.3, not 7.0.2                                                                                                                                                                                                                                                                                               | typescript-eslint 8.72.0 supports `<6.1.0` only                                                                        |
| 2026-10-22 | Prisma pinned at 7.10.1                                                                                                                                                                                                                                                                                                             | npm `latest` tag is an 8.0 release candidate                                                                           |
| 2026-10-22 | Commit subjects: `T-NNN[a]: ...`; `docs:`/`chore:` allowed for non-ticket housekeeping                                                                                                                                                                                                                                              | Enforced by `.husky/commit-msg` → `scripts/commit-msg.mjs`                                                             |
| 2026-10-22 | **ADR-023 (proposed):** TypeScript runs natively on Node 24 — `.ts` imports, `erasableSyntaxOnly`, `tsc` build to `apps/api/dist`, `@hotel/shared` and the Prisma client loaded as TS source                                                                                                                                        | See `docs/adr/023-native-typescript.md`                                                                                |
| 2026-10-22 | `cors` 2.8.6 added (not in the spec's stack list)                                                                                                                                                                                                                                                                                   | Standard Express CORS middleware for the allow-list                                                                    |
| 2026-10-22 | Body over 100 kB and malformed JSON return 400 `VALIDATION_ERROR` (with `details.limitBytes` for size), not 413                                                                                                                                                                                                                     | Tab 4 lists no 413 code                                                                                                |
| 2026-10-22 | HTTP request logs carry only id, method, URL, IP, status; `/health` not logged                                                                                                                                                                                                                                                      | No headers/cookies in logs; Render polls `/health`                                                                     |
| 2026-10-22 | Schema additions 1–8 approved by Philip                                                                                                                                                                                                                                                                                             |                                                                                                                        |
| 2026-10-22 | Repo committed on `main` directly; ticket branches once a GitHub remote exists                                                                                                                                                                                                                                                      | Runbook §1 daily workflow                                                                                              |
| 2026-10-24 | First migration = tenancy + identity only: organisations, properties, departments, feature_flags, property_counters, users, sessions, roles, memberships, auth_tokens, invitations, rate_limit_hits. Audit, approvals, idempotency, outbox and files tables arrive with T-014, T-022, T-020, T-021, T-023; subscriptions with T-100 | Each ticket owns its migration; additive migrations                                                                    |
| 2026-10-24 | Prisma 7 setup: `prisma.config.ts` (loads `.env` with `process.loadEnvFile`), `prisma-client` generator → `apps/api/src/generated/prisma` (gitignored, regenerated on `postinstall`), `@prisma/adapter-pg` driver adapter                                                                                                           | Prisma 7 requires a config file and a driver adapter                                                                   |
| 2026-10-24 | Composite FKs added now where tenancy tables reference each other: memberships/invitations/departments → `properties(organisation_id, id)`, memberships/invitations → `roles(organisation_id, id)`, memberships → `departments(property_id, id)`                                                                                    | Approved issue 8; a row can't point at another organisation's property or role                                         |
| 2026-10-24 | Extra CHECKs: lower-case emails, E.164 phones, email-or-phone present, ISO country/currency codes, HH:MM property times, department needs property, PIN session not a shared device, counters non-negative                                                                                                                          | Cheap DB-level guarantees; all tested                                                                                  |
| 2026-10-24 | Property counters use `INSERT … ON CONFLICT DO UPDATE … RETURNING` (upsert) rather than a plain `UPDATE`                                                                                                                                                                                                                            | Works for the first number without pre-creating rows; still one atomic statement                                       |
| 2026-10-24 | Integration tests: `globalSetup` runs `prisma migrate deploy` on `TEST_DATABASE_URL`; each test truncates tables; files run serially; `test/db.ts` refuses a database whose name doesn't end in `_test`                                                                                                                             | Prisma 7 blocks `migrate reset` when an AI agent runs it, and `deploy` never drops data. Issue 11, approved 2026-10-24 |
| 2026-10-24 | Test helpers and factories live in `apps/api/test/` (moved from `src/test/`)                                                                                                                                                                                                                                                        | Matches the tab 2 repository layout                                                                                    |
| 2026-10-24 | package-lock.json regenerated from scratch (Philip approved) after npm/cli#4828 dropped rolldown platform packages; all direct pins unchanged                                                                                                                                                                                       | CI on Linux needs `@rolldown/binding-linux-x64-gnu`                                                                    |
| 2026-10-24 | Seed users are ACTIVE with no password                                                                                                                                                                                                                                                                                              | Sign-in arrives with T-010, which will set a dev password                                                              |

## Deviations from the spec

| Item               | Spec                                                                      | Done                                                           | Why                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| TypeScript version | "Pin current stable"                                                      | 6.0.3 (7.0.2 is newest)                                        | Lint tooling compatibility                                                                                                  |
| Test isolation     | "Each test runs in a transaction rolled back" (tab 8)                     | Truncate per test + serial files (implemented in T-003)        | Prisma can't nest interactive transactions inside a wrapping test transaction. **Approved by Philip 2026-10-24 (issue 11)** |
| Seed contents      | Runbook: "demo organisation, 1 property, 30 rooms, rates, users per role" | Org, property, 5 departments, 12 roles, 12 users + memberships | Rooms and rates tables arrive with T-031/T-033; the seed grows then                                                         |

## Open spec issues (proposed fix → waiting for Philip unless marked)

**Needed soon (Sprints 0–2)** — items 1–8 **approved 2026-10-22**

1. ✅ Done in T-003. **Auth token tables** — `auth_tokens` and `invitations`.
2. ✅ Done in T-003 (table). **Rate limiter store** — `rate_limit_hits`; middleware in T-010.
3. **WhatsApp OTP approvals** — add `otpHash`, `otpExpiresAt`, `otpAttempts` to `approval_requests` (T-022).
4. ✅ Done in T-003 (schema). **PIN switch** — `sessions.parentSessionId` with cascade; logic in T-011.
5. ✅ Done in T-003. **Membership uniqueness** — `NULLS NOT DISTINCT`.
6. ✅ Done in T-003. **Per-property numbering** — `property_counters` + `nextPropertyCounter()`.
7. **Audit "device"** — add `userAgent` to `audit_events` (T-014).
8. ✅ Partly done in T-003 (tenancy tables). **Composite FKs** — room and money relations follow with their tables.
9. **Malware scan engine** unnamed; Render's native Node runtime can't run ClamAV. `FileScanner` adapter + fake now; ClamAV in a Docker-based worker at T-023.
10. **Nightly `pg_dump`** — Render's native Node image may not ship `pg_dump`. Same Docker worker with `postgresql-client`, decided at T-025.
11. ✅ Approved 2026-10-24. **Test isolation** by truncation — see Deviations.
12. **Render blueprint** runs `prisma generate` after the TS build; the build needs the generated client first. Swap the order (now also covered by `postinstall`). CI uses `postgres:16`, local is 18 → align CI to the production major.

**Later in V1**

13. **Trial-balance AC sign error** (M4). Deposits are a liability, so: `charges − payments − AR transfers = Δguest ledger − Δdeposit ledger`, with "charges" excluding DEPOSIT_APPLY / TRANSFER lines. (A ₦100 deposit with the spec's formula gives −100 = +100.)
14. **Night audit steps** — PRD has 10 steps, Strategy §7.2 has 7 in another order → PRD wins. Schema has no per-step table but `GET /night-audits/{id}` returns per-step status and exceptions. Add `night_audit_steps (runId, step, name, status, exceptions, startedAt, finishedAt)`.
15. **Overbooking limit "per room type"** (M2-09) exists only on per-date inventory rows. Add `room_types.overbookLimit`, copied into inventory rows on build.
16. **Inventory CHECK vs out-of-order**: on a fully sold night, putting a room out of order violates `sold + held + out_of_order ≤ capacity + overbook`, but M5 says a critical fault removes the room "within the same request". Proposed: return 409 with the conflicting nights and offer OUT_OF_SERVICE until stays are moved. **Needs your call.**
17. **Day-use**: arrival = departure gives an empty `daterange`, so the exclusion constraint never protects day-use; hour-block pricing has no columns. Add a `tstzrange` exclusion for day-use allocations, `rate_plans.dayUseBlockMinutes`, and treat `rate_days.amountMinor` as price per block.
18. **Inclusive stacked taxes** have no algorithm. Back out net from gross with the combined rate, compute taxes forward, put the rounding residue on the net line. The "worked example" fixture for M4 isn't in the spec; derived from the quote example's order: ₦100,000 → SVC 10% ₦10,000 → VAT 7.5% on net+SVC ₦8,250 → LCT 5% on net ₦5,000 = ₦123,250.
19. **Manual payment duplicates**: `(provider, externalRef)` with provider NULL never collides, so `PAYMENT_DUPLICATE` can't fire for POS-terminal/bank-transfer refs. Provider `MANUAL` + partial unique `(propertyId, method, externalRef)`.
20. **Core leakage rule "Unmatched transfer"** needs bank matching, which is V1.1 (M4-23). V1 scope: `unmatched_transfers` older than 24 h + manual BANK_TRANSFER payments not linked to a provider transfer. **Needs your call.**
21. **Limits in two places** (`roles.limits` vs `approval_policies.threshold*`). Effective limit = role limit if set, else policy threshold; approver must hold `approval.decide` and a role in `approverRoleIds`.
22. **Permission codes** differ between PRD and API tab (e.g. API `frontdesk.*`, `role.manage`, `guest.manage` vs PRD `reservation.checkin`, `room.assign`, `role.assign`, `guest.flag`). PRD codes are canonical.
23. **Strategy §15.2 paths and `APPROVAL_REQUIRED`** differ from the API tab → API tab wins (202, no `APPROVAL_REQUIRED`).
24. **Waitlist** (Strategy, Feature Versions V1) has no PRD story, table or AC → not built until a story exists.
25. **Reservation vs stay status** for multi-room bookings: derive reservation status from its stays; store it for querying.
26. **API tab Reports row** is malformed (release column lost) → treated as V1.
27. **Inventory horizon** undefined → build 730 days ahead, extend nightly.
28. **Idempotency keys are keyed on `userId`**; system-run night audit and V1.2 public endpoints have no user → synthetic principals (`system:<propertyId>`); purge expired keys in the cleanup job.
29. **New (T-003): CHECK violations carry the full failing row** in the Postgres error detail (e.g. a user's email). When services map DB errors to responses/logs (T-010 onward), log only `pgErrorInfo()` (SQLSTATE + constraint), never the raw error.

## Known gaps

- No schema-drift check in CI yet (manually verified in T-003: `prisma migrate dev --create-only` produced an empty migration). Add to T-004.
- No GitHub remote yet (needed for T-004).
- `apps/web` and `apps/site` contain placeholder `src/index.ts` files only.
- Middleware steps 5–8 (session, CSRF Origin check, tenancy, rate limiter) are marked in `apps/api/src/app.ts` for T-010/T-012.
- `/health` does not check the database (liveness only). A readiness check is not in the spec.
