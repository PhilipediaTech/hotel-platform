# Progress

Source of truth: [Master Specification v3.0](https://claude.ai/artifact/1RvubmsUXQrRo4kqaNMUkq). Authority when tabs conflict: Decision Log > Master PRD > Architecture > Schema / API > Strategy.

## Status

| Item             | Value                          |
| ---------------- | ------------------------------ |
| Current sprint   | S0 (V0 Engineering foundation) |
| Last ticket done | T-002                          |
| Next ticket      | T-003 Prisma setup             |
| Tests passing    | 56 (4 files)                   |

## Tickets

| Ticket                                                            | Status                                  | Tests                                | Commit       |
| ----------------------------------------------------------------- | --------------------------------------- | ------------------------------------ | ------------ |
| T-001 Monorepo, TypeScript strict, ESLint, Prettier, commit hooks | Done                                    | 15 (commit-message rule)             | `T-001: ...` |
| T-002 Express skeleton                                            | Done                                    | 41 (app, config, shared error codes) | `T-002: ...` |
| T-003 Prisma setup, first migration, seed                         | Next (schema additions 1–8 approved)    |                                      |              |
| T-004 GitHub Actions                                              | Needs a GitHub remote                   |                                      |              |
| T-005 Staging on Render + Cloudflare                              | **Stop — needs paid accounts (Philip)** |                                      |              |
| T-006 React + Vite PWA shell                                      | Pending                                 |                                      |              |
| T-007 Zod → OpenAPI                                               | Pending                                 |                                      |              |

## Decisions taken in the build

| Date       | Decision                                                                                                                                                                                                                                                             | Why                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 2026-10-22 | TypeScript pinned at 6.0.3, not 7.0.2                                                                                                                                                                                                                                | typescript-eslint 8.72.0 supports `<6.1.0` only                                                                     |
| 2026-10-22 | Prisma to be pinned at 7.10.1                                                                                                                                                                                                                                        | npm `latest` tag is an 8.0 release candidate                                                                        |
| 2026-10-22 | Commit subjects: `T-NNN[a]: ...`; `docs:`/`chore:` allowed for non-ticket housekeeping                                                                                                                                                                               | Enforced by `.husky/commit-msg` → `scripts/commit-msg.mjs`                                                          |
| 2026-10-22 | Each workspace exports TypeScript source (`exports: ./src/index.ts`)                                                                                                                                                                                                 | Node 24 runs it directly (type stripping)                                                                           |
| 2026-10-22 | API runs TypeScript natively: source imports use `.ts`; `erasableSyntaxOnly` (no enums/namespaces/parameter properties); `tsc` build rewrites to `.js` in `apps/api/dist`; `@hotel/shared` is loaded as TS source at runtime. No tsx/nodemon (`node --watch` in dev) | Fewer moving parts; matches the Render start command `node apps/api/dist/server.js`. Needs Node ≥ 22.18 (pinned 24) |
| 2026-10-22 | `cors` 2.8.6 added (not in the spec's stack list)                                                                                                                                                                                                                    | Standard Express CORS middleware for the allow-list                                                                 |
| 2026-10-22 | Body over 100 kB and malformed JSON return 400 `VALIDATION_ERROR` (with `details.limitBytes` for size), not 413                                                                                                                                                      | Tab 4 lists no 413 code; envelope stays within the spec codes                                                       |
| 2026-10-22 | HTTP request logs carry only id, method, URL, IP, status; `/health` not logged                                                                                                                                                                                       | No headers/cookies in logs; Render polls `/health`                                                                  |
| 2026-10-22 | Schema additions 1–8 approved by Philip                                                                                                                                                                                                                              | Used in T-003 onward                                                                                                |
| 2026-10-22 | Repo committed on `main` directly (root commit); later tickets on `feat/T-NNN-*` branches once a GitHub remote exists                                                                                                                                                | Runbook §1 daily workflow                                                                                           |

## Deviations from the spec

| Item               | Spec                                                  | Done                                                      | Why                                                                                                         |
| ------------------ | ----------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| TypeScript version | "Pin current stable"                                  | 6.0.3 (7.0.2 is newest)                                   | Lint tooling compatibility                                                                                  |
| Test isolation     | "Each test runs in a transaction rolled back" (tab 8) | Proposed: truncate per test file + unique tenant per test | Prisma can't nest interactive transactions inside a wrapping test transaction. Awaiting approval (issue 11) |

## Open spec issues (proposed fix → waiting for Philip unless marked)

**Needed soon (Sprints 0–2)** — items 1–8 **approved 2026-10-22**

1. **Auth token tables missing** (M1-01 email verify, password reset, M1-04 invitations). Add `auth_tokens` (purpose, tokenHash, userId, expiresAt, usedAt) and `invitations` (org, property, role, email/phone, tokenHash, expiresAt, acceptedAt).
2. **Rate limiter "stored in PostgreSQL"** has no table. Add `rate_limit_hits` (key, windowStart, count); purge in the session-cleanup job.
3. **WhatsApp OTP approvals** (M1-10) have nowhere to store the code. Add `otpHash`, `otpExpiresAt`, `otpAttempts` to `approval_requests`.
4. **PIN switch on shared devices** (M1-07) has no device model. Device session (`sharedDevice = true`, opened by a manager) + per-user child session via new `sessions.parentSessionId`.
5. **Membership uniqueness** with nullable `propertyId` lets duplicate org-wide memberships in. Raw SQL `UNIQUE NULLS NOT DISTINCT`.
6. **Per-property numbering** (confirmation `LAG-24117`, folio, task numbers) has no mechanism. Add `property_counters (propertyId, name, value)`, incremented with `UPDATE … RETURNING` in the same transaction.
7. **Audit "device"** is in Architecture but not in `audit_events`. Add `userAgent`.
8. **Composite FKs** (Architecture: "(propertyId, id) on child tables") vs Schema (child tables lack `propertyId`). Add `@@unique([propertyId, id])` on parents and composite FKs on room and money relations (stays→rooms, room_allocations→rooms, folio_lines→folios, payments→folios, stays→reservations).
9. **Malware scan engine** unnamed; Render's native Node runtime can't run ClamAV. `FileScanner` adapter + fake now; ClamAV in a Docker-based worker at T-023.
10. **Nightly `pg_dump`** — Render's native Node image may not ship `pg_dump`. Same Docker worker with `postgresql-client`, decided at T-025.
11. **Test isolation** — see Deviations.
12. **Render blueprint** runs `prisma generate` after the TS build; the build needs the generated client first. Swap the order. CI uses `postgres:16`, local is 18 → align CI to the production major.

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

## Known gaps

- Local Node is 22.15.0; the repo pins 24.22.1. Tests and the build pass on 22.15, but `npm run dev` / `npm start -w apps/api` need Node 24 (22.15 needs `--experimental-strip-types`). The T-002 smoke run used that flag.
- PostgreSQL 18 `bin` is not on PATH (needed for `psql`/`createdb`/`pg_dump`).
- No GitHub remote yet (needed for T-004).
- `apps/web` and `apps/site` contain placeholder `src/index.ts` files only.
- Middleware steps 5–8 (session, CSRF Origin check, tenancy, rate limiter) are marked in `apps/api/src/app.ts` for T-010/T-012.
