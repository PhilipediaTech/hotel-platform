# Handoff

Read this first in a fresh session, then `docs/PROGRESS.md`.

## What this is

Production hotel PMS SaaS built from "Hotel Management Platform — Master Specification v3.0" ([link](https://claude.ai/artifact/1RvubmsUXQrRo4kqaNMUkq), 11 tabs). Product owner and developer: Philip (MERN background; ships Express 5 + Prisma + PostgreSQL + Zod + Vitest + Playwright).

## Working rules (from Philip)

- Follow tab 6 (Implementation Backlog) ticket by ticket; re-read the cited PRD stories, schema models, API contracts and UI screens first.
- Every PRD acceptance criterion becomes at least one automated test. Read files before editing; never guess shapes.
- Commit after each ticket: `T-042: reservations create/modify/cancel` (enforced by the commit-msg hook). Since T-004: work on a branch `feat/T-0NN-<slug>`, push, open a pull request into `main` (remote `origin` = github.com/PhilipediaTech/hotel-platform); CI (`.github/workflows/ci.yml`) must be green before merging.
- Keep `docs/PROGRESS.md` and this file current; new architectural decisions go in `docs/adr/` and must be reported to Philip.
- Stop and ask before: spending money or creating paid accounts; touching production; open ADRs 019–022 and the tax stack per state; deleting files; rewriting applied migrations; schema changes the spec doesn't cover; changing the stack or an accepted ADR.
- Commands given to Philip never contain placeholders.

## Environment

- Windows 11, Git Bash, VS Code. Repo at `C:\Users\USER\Desktop\hotel-platform`.
- Node 24.22.1 (matches `.nvmrc`).
- PostgreSQL 18 native (service `postgresql-x64-18`, binaries in `C:\Program Files\PostgreSQL\18\bin`). Databases `hotel_dev` (migrated + seeded), `hotel_test` (tests), `hotel_e2e`, `hotel_restore`.
- `.env` holds `DATABASE_URL`, `TEST_DATABASE_URL`, `E2E_DATABASE_URL` with Philip's password — never print it.

## Repo layout (as of T-030)

```text
prisma/
  schema.prisma                 Prisma models (tenancy + identity so far)
  migrations/                   SQL migrations; raw-SQL constraints appended by hand before applying
  seed.ts                       seed(db, { password }): demo org/property/departments/roles/users from the identity templates (idempotent)
prisma.config.ts                Prisma 7 config (schema, migrations, seed, datasource URL; loads .env)
apps/api        @hotel/api      Express 5 app
  src/server.ts                 HTTP entry (config → logger → db → app.listen, graceful shutdown)
  src/worker.ts                 worker entry: pg-boss scheduled jobs, outbox handlers, outbox publisher
  src/jobs.ts                   workerJobs({ files, scanner }) and eventHandlers() the worker runs (modules add theirs here)
  src/approval-actions.ts       APPROVAL_HANDLERS: protected actions the approvals engine executes
  src/app.ts                    createApp({ config, logger, routes }) — middleware order per tab 2
  src/core/config.ts            env → Config (Zod)
  src/core/db.ts                createDb(url) (PrismaPg adapter), Db/DbClient types, pgErrorInfo()
  src/core/counters.ts          nextPropertyCounter(db|tx, propertyId, COUNTER.x)
  src/core/route.ts             mountRoute(router, contract, handler): validate in, schema-shaped out
  src/core/auth.ts              sessions: SESSION_POLICY, createSession, sessionLoader (step 5), requireAuth/getAuth, cookies
  src/core/csrf.ts              originCheck (step 6)
  src/core/rate-limit.ts        rateLimiter (step 8), RATE_LIMITS
  src/core/tenancy.ts           tenancyContext (step 7), resolveTenant, currentTenant/requireTenant, runAsTenant
  src/core/tenant-db.ts         createTenantDb(db): Prisma extension scoping TENANT_MODELS by tenant
  src/core/approvals.ts         performOrRequest, needsApproval, approve/reject (execute once), expireRequests, issueApprovalOtp
  src/core/outbox.ts            recordEvent(tx, …) (domain_events), publishPending, EventHandler
  src/core/jobs.ts              defineJob, startWorker (pg-boss)
  src/core/cleanup.ts           hourly cleanup job (sessions, links, rate limits, idempotency keys, old events)
  src/core/idempotency.ts       idempotencyStore middleware + withIdempotency (used by mountRoute for ● routes)
  src/core/audit.ts             auditContext (request facts), recordAudit(tx, …), recordUserEvent (fan-out), auditValue (redaction)
  src/core/passwords.ts         scrypt hashPassword/verifyPassword/burnPasswordCheck
  src/core/tokens.ts            newToken, hashToken (HMAC with SESSION_SECRET)
  src/core/mfa.ts               AES-GCM secret encryption, TOTP verify (replay-safe), recovery codes
  src/core/email.ts             EmailProvider + createFakeEmailProvider
  src/core/files.ts             FileStore interface, createLocalFileStore (fake: signed links under /api/v1/local-files), fileStorageKey/incomingKey
  src/core/file-scan.ts         FileScanner + createFakeFileScanner (EICAR), matchesContentType (magic bytes)
  src/core/clock.ts             Clock (inject time in tests)
  src/modules/identity/         service.ts (sign-up, sign-in, reset, me), mfa.ts, pin.ts (devices), routes.ts, role-templates.ts
  src/modules/access/           users, roles, invitations (S26 API): service.ts, routes.ts, emails.ts
  src/modules/audit/            GET /audit-events (S27 API): service.ts, routes.ts
  src/modules/approvals/        inbox and policies API, default policies, expiry job, OTP stub handler
  src/modules/files/            upload-url / download-url, scanPendingFiles + file-scan job (every minute)
  src/modules/setup/            organisation, properties, setup checklist (checklistFor) and go-live
  src/modules/rooms/            room types, rooms (If-Match), blocks, room-block-status job (every 15 min)
  src/modules/tax/              revenue codes, tax rules and versions, confirm; defaults.ts = Lagos EXAMPLE taxes
  src/modules/rates/            cancellation policies, rate plans (If-Match), rate calendar (bulk SQL upsert), packages
  src/modules/imports/          check (POST /imports) and apply spreadsheet imports: ROOMS, RATES
  src/modules/guests/           guests (search, flags, merge → moveGuestReferences) and companies
  src/modules/reservations/     book from quotes, change, cancel, reinstate; hold-expiry job; do-not-rent approval
                                rooms.ts: room allocations, assign (room.not_ready approval), move (room.move approval)
                                check-in.ts: check-in, registration card, key log, ID purge job
  src/modules/availability/     inventory.ts: rebuildInventory, takeInventory/releaseInventory, daily job; inventory API;
                                quotes.ts: GET /availability, POST /quotes (live pricing, restrictions, taxes per night)
  src/core/openapi.ts           buildOpenApiDocument(routes) / openApiDocument() (cached)
  scripts/openapi.ts            npm run openapi → apps/api/openapi.json (committed; test checks it)
  src/core/request-id.ts        X-Request-Id
  src/core/logger.ts            pino + pino-http (redaction, slim serializers)
  src/core/errors.ts            AppError, notFoundHandler, errorHandler → error envelope
  src/generated/prisma/         generated client (gitignored; `npm run db:generate`, also on postinstall)
  test/helpers.ts               buildTestApp(), errorOf(), TEST_CONFIG
  test/db.ts                    testDb(), resetDb(), expectViolation(), SQLSTATE
  test/factories.ts             makeOrganisation/Property/Role/User/Tenant
  test/global-setup.ts          prisma migrate deploy on TEST_DATABASE_URL
  test/auth.ts                  authApi, cookies, verifiedUser, signIn (sign-in, MFA and PIN tests)
  test/tenancy.ts               makeTenantWorld, sessionCookie, expectCrossTenantSafe (cross-tenant harness)
  test/cross-tenant-cases.ts    one case per property-scoped route (the suite fails without it)
  test/hotel.ts                 makeHotel(db, now) + hotelClient(db, clock, propertyId) for access and audit tests
apps/web        @hotel/web      React 19 + Vite 8 PWA (staff and owner app)
  src/main.tsx                  QueryClientProvider → SessionContext → RouterProvider
  src/app/navigation.ts         NAV_ITEMS (screen + ticket per item), HOMES, homeFor/railItems/bottomBarItems
  src/app/routes.tsx            AppShell layout route; a placeholder route per screen until its ticket
  src/app/session.ts            ShellSession, toShellSession(me, propertyId), SessionActions; PREVIEW_SESSION for tests
  src/app/session-gate.tsx      SessionGate: GET /me → session or redirect to /sign-in?next=
  src/routes/auth/              S01 sign-in, /mfa, /pin; S02 sign-up; verify-email, forgot/reset password; /account/pin
  src/lib/form.ts               zodResolver, apiFieldErrors, errorMessage
  src/routes/settings/access.tsx S26 Users and roles; app/routes.tsx SCREENS maps implemented screens
  src/routes/audit.tsx          S27 Audit log
  src/routes/approvals.tsx      Approvals inbox; src/routes/settings/approval-policies.tsx S26 policies tab
  src/routes/onboarding.tsx     S02 setup wizard: checklist, step forms, go-live
  src/routes/settings/rooms.tsx S24 rooms, room types (photos) and QR print sheet; rooms-tab, room-types-tab
  src/routes/settings/finance.tsx S25 taxes (example banner, versions, worked example) and revenue codes
  src/routes/rates.tsx          S23 rate grid, bulk edit, plan and package forms
  src/routes/settings/imports.tsx S03 imports: template, upload, report, apply
  src/routes/rooms-left.tsx     S23 "Rooms left" view and overbooking form
  src/routes/guests.tsx         S13 guests: search, add, profile (details, flags, merge); companies.tsx
  src/routes/reservations.tsx   S09 reservations: find, detail (change, confirm hold, cancel, reinstate, history)
  src/routes/new-booking.tsx    S08 new booking: search, plans, guests, guarantee, book (walk-in mode: ?mode=walk-in)
  src/routes/calendar.tsx       S07 calendar: rooms × dates, unassigned rows per type, blocks, rooms left
  src/routes/check-in.tsx       check-in form (on S09), key log, printable registration card (/stays/:id/card)
  src/app/query-client.ts       TanStack Query defaults (shouldRetry)
  src/lib/api.ts                createApiClient / api, ApiError (typed by API_ROUTES)
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
  src/api/primitives.ts         Uuid, IsoDate, Instant, AmountMinor, Money, PageQuery, page(), ErrorEnvelopeSchema
  src/api/contract.ts           defineRoute, RouteContract, RouteInput/ParsedRouteInput/RouteResponse, routeErrorCodes
  src/api/routes.ts             API_ROUTES — add every new endpoint here
  src/api/testing.ts            EXAMPLE_ROUTES (import from @hotel/shared/testing)
  src/api/auth.ts, access.ts, audit.ts, approvals.ts  auth/me, users-and-roles, audit-log and approvals contracts
  src/approvals.ts              APPROVAL_ACTIONS catalogue (protected actions, measures, defaults)
  src/files.ts                  FILE_KINDS catalogue (entity type → permission, types, max size), link lifetimes
  src/setup.ts                  SETUP_STEPS checklist, MANUAL_PAY_METHODS, LOCKED_WHEN_LIVE
  src/dates.ts                  localDate(instant, timeZone), addDays, daysBetween (YYYY-MM-DD)
  src/tax.ts                    calculateTaxes, versionsOn, formatRate; tax.fixtures.ts worked examples
  src/rates.ts                  derivedAmount, restrictionViolations, splitPackage
  src/imports.ts                IMPORT_COLUMNS, parseSheet (cell checks), parseCsv, templateCsv
  src/permissions.ts            PERMISSIONS catalogue, HOTEL_PERMISSION_CODES, RoleLimits
docs/           PROGRESS, HANDOFF, VERSIONS, adr/000–023
```

Root scripts (`dev` runs api :4000, the worker and web :5173 via `scripts/dev.mjs`; `check:size` builds web and checks the budget): `dev | check:size | openapi | openapi:check | build | lint | typecheck | format | format:check | test | check | db:generate | db:migrate | db:deploy | db:reset | seed`.

## Conventions

- **TypeScript (ADR-023):** relative imports end in `.ts`; no enums, namespaces or constructor parameter properties. Use `as const` objects.
- **Schema changes:** edit `schema.prisma` → `npx --no-install prisma migrate dev --create-only --name <name>` → append raw SQL (CHECKs, exclusion constraints, triggers) to the generated `migration.sql` → `npm run db:migrate` → confirm a second `--create-only` produces an empty migration (no drift) and delete it. Never edit an applied migration.
- **Prisma 7 refuses `migrate reset` from an AI agent** without Philip's explicit consent. Don't use it; tests use `migrate deploy` + truncation.
- **Tests:** `*.test.ts` = unit project; `*.int.test.ts` = integration project (real PostgreSQL, serial files, `resetDb()` in `beforeEach`). Constraint tests use `expectViolation(write, SQLSTATE.X, 'constraint_name')`.
- **DB errors:** map with `pgErrorInfo(err)`; never log the raw Postgres error (CHECK details contain the row).
- **Web:** every UI string goes in `src/i18n/en.json`; use the design tokens (`bg-surface`, `text-brand`, `text-critical`…), not raw palette colours; status is always text + icon, never colour alone. A new screen replaces its placeholder by adding a route at its `NAV_ITEMS` path. Component tests: `*.test.tsx` under `apps/web/src`.
- **New endpoint:** define it with `defineRoute` in `packages/shared/src/api/routes.ts` (wire formats from `primitives.ts`; money as `Money`, dates `IsoDate`, no transforms in responses), add it to `API_ROUTES`, implement with `mountRoute` in the module’s `routes.ts`, run `npm run openapi`, and call it from the web app with `api.call('<operationId>', …)`.
- **Signed-in routes:** contracts default to `auth: 'session'`, so `mountRoute` answers 401 before your handler runs; read the user with `requireAuth(req)` (or `ctx.auth`). Non-GET requests in tests need `.set('Origin', APP_ORIGIN)`. Integration tests that sign in use `buildTestApp(undefined, { db: testDb(), clock })` and read links from the returned fake `email`.
- **Tenant data:** property-scoped contracts (`propertyScoped: true`, plus `permission`) get `ctx.tenant`. Read and write tenant tables only through `createTenantDb(db)`; add every new tenant table to `TENANT_MODELS` in `core/tenant-db.ts`; add a case for every property-scoped route to `test/cross-tenant-cases.ts`. Raw SQL must filter by `requireTenant()` IDs itself.
- **Permissions:** every new endpoint names one catalogue code in its contract (`permission`); add new codes to `packages/shared/src/permissions.ts` (and to the role templates that should get them). Contract PATCH bodies must not carry defaults (use a default-free schema; Zod `.partial()` keeps defaults).
- **Audit:** every state change writes `recordAudit(tx, { action: 'resource.verb', entityType, entityId, before, after, reason? })` with the same transaction client as the change (plain or tenant client). Never audit after the commit except for sign-in-type events; never put secrets in before/after (they are stripped by key name, but don’t rely on it). Add a label for new actions under `audit.actions` in `en.json`.
- **Side effects across modules:** never call another module's side effect directly; `recordEvent(tx, { type: 'resource.past_tense', payload })` in the change's transaction and add an `EventHandler` (to `EVENT_HANDLERS` in `src/jobs.ts`) that must tolerate running twice. Timetabled work is a `defineJob` with `schedule` in `workerJobs()`. Payloads carry IDs and facts, never secrets.
- **Protected actions (approvals):** an action in `APPROVAL_ACTIONS` is performed only through `performOrRequest(deps, tenant, handler, payload, reason)` from a route marked `approval: true`; define its `ApprovalActionHandler` (payload schema, `measure`, `execute` that re-validates current state and passes `approvalRequestId` to its audit events) and add it to `APPROVAL_HANDLERS`. Never add an "approve" path of your own.
- **Files:** a record that takes files adds its kind to `FILE_KINDS` (permission, types, size). The web app uploads with `uploadFile(entityType, file)` (`apps/web/src/lib/files.ts`) and stores the returned file ID on the record; the file opens once the scan job marks it CLEAN (`GET /files/{id}/download-url`, else 409 `FILE_NOT_READY`). Never serve a file any other way. Locally, files land in `.data/files`.
- **Setup checklist:** a ticket that builds a checklist step (T-031 room types and rooms, T-032 tax, T-033 rates) removes `later` from its entry in `SETUP_STEPS` and adds its check to `stepDone` in `modules/setup/service.ts`. Booking routes (T-042) refuse a property that is not LIVE with 403 `PROPERTY_NOT_LIVE`.
- **Rooms:** OUT_OF_ORDER/OUT_OF_SERVICE housekeeping status always comes from a `room_blocks` row (the `room-block-status` job keeps them in step); housekeeping (T-080) creates blocks rather than setting those statuses. Availability (T-040/T-041) counts unreleased OUT_OF_ORDER blocks; OUT_OF_SERVICE rooms stay counted but are not assignable. Versioned resources answer with `ETag` and take `If-Match: "<version>"` (see `modules/rooms/routes.ts`). Test sessions on a fixed clock: `sessionCookie(db, userId, clock)`.
- **Taxes:** anything that prices or posts (quotes T-041, folios T-060, night audit T-073) uses `calculateTaxes` with `versionsOn(versions, businessDate)` of the revenue code’s `taxRuleIds`, and stores the version IDs and amounts on the line; never recalculate posted lines. Tax rule versions are written through their rule (`taxRule.update({ data: { versions: … } })`): the tenant client scopes rules, not versions.
- **Rates:** the price a plan sells at on a day is `sellingPrice(plan, ownDay, parentDay)` in `modules/rates/service.ts` (derived plans via `derivedAmount`); quotes (T-041) store the `rule_version` of each night’s row(s) and check `restrictionViolations`. Package nights post via `splitPackage`.
- **Imports:** a new kind (GUESTS with T-043, COMPANIES, BALANCES with folios) adds its columns to `IMPORT_COLUMNS` and a branch in `parseSheet`, a `check…`/`apply…` pair in `modules/imports/service.ts`, and the kind to `IMPORT_KINDS`. `.xlsx` test fixtures are plain zips (see `apps/api/test/fixtures/rooms.xlsx`).
- **Inventory:** anything that changes rooms, room types or out-of-order blocks calls `rebuildInventory` in its transaction (see `refreshInventory` in `modules/rooms/service.ts`). Reservations take nights with `takeInventory(tx, …, field: 'sold' | 'held')` and give them back with `releaseInventory`; never update `sold`/`held` directly.
- **Quotes:** a booking (T-042) loads the quote (same property, not expired, same room type/plan/dates), re-checks occupancy, calls `takeInventory` per stay, and copies the quote’s `nights` (price, rule version, lines with tax versions) into `stay_nights`; posting (T-060/T-073) uses those lines. An expired quote means quoting again.
- **Guests:** guests and companies are organisation-wide (tenant kind `organisation`). Anything that stores a guest ID (reservations, stays, folios) must add its update to `moveGuestReferences` in `modules/guests/service.ts`, so merges move it. Never send `vip`/`doNotRent`/`flagReason` to callers without `guest.flag`.
- **Reservations:** every status change goes through `RESERVATION_TRANSITIONS` (packages/shared) and takes or gives back inventory in the same transaction (`inventoryFieldOf`: held/sold), with a history row (nested through the reservation: history and stay nights have no property column), an audit event and an outbox event. Room assignment (T-050), check-in/out (T-051) and no-show (night audit) add their transitions the same way. Quotes store `guests` per night; a stay must match.
- **Local sign-in:** `npm run seed`, then any `<role-slug>@demo.hotel.test` (e.g. `owner@`, `front-desk@`) with `SEED_USER_PASSWORD` from `.env`. Verification and reset links are printed in the API log.
- **MFA and PINs locally:** Owner, GM and Finance demo users must set up MFA at first sign-in; generate codes from the shown key with `node --input-type=module -e "import { generate } from 'otplib'; console.log(await generate({ secret: '<key>' }))"` (run in `apps/api`). For PIN switching: set a PIN at `/account/pin` (e.g. as `front-desk@`), sign in as `dept-manager@` with "shared device" ticked, then Account menu → Switch user. Integration tests for these flows use `test/auth.ts`.
- **Lockfile:** never regenerate it with `node_modules` or the old lock present (npm/cli#4828 drops platform bindings); follow the procedure in PROGRESS decisions. After any dependency change, `grep -c "node_modules/@rolldown/binding-" package-lock.json` must print 15.

## Next step

T-052 walk-in and day-use flows (M3-09 walk-in in under 2 minutes / ≤ 6 steps in the E2E test: today the walk-in books on S08 and checks in on S09 — consider one screen that books and checks in; M3-10 day-use: start time and duration, DAY_USE plans priced per stay (quotes say "Day-use plans are quoted with day-use bookings (T-052)"), a day-use allocation covers [arrival, arrival + 1), the room returns to dirty at the end; M3 acceptance on day-use revenue vs room nights). The import still needs GUESTS/COMPANIES and BALANCES (folios). Philip still has to confirm the example tax rates in S25. Still waiting for accounts: R2 and the scan engine, T-024 notifications, T-025 nightly dump, T-005 staging (paid: stop and ask).
