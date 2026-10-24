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

## Repo layout (as of T-012)

```text
prisma/
  schema.prisma                 Prisma models (tenancy + identity so far)
  migrations/                   SQL migrations; raw-SQL constraints appended by hand before applying
  seed.ts                       seed(db, { password }): demo org/property/departments/roles/users from the identity templates (idempotent)
prisma.config.ts                Prisma 7 config (schema, migrations, seed, datasource URL; loads .env)
apps/api        @hotel/api      Express 5 app
  src/server.ts                 HTTP entry (config → logger → db → app.listen, graceful shutdown)
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
  src/core/passwords.ts         scrypt hashPassword/verifyPassword/burnPasswordCheck
  src/core/tokens.ts            newToken, hashToken (HMAC with SESSION_SECRET)
  src/core/mfa.ts               AES-GCM secret encryption, TOTP verify (replay-safe), recovery codes
  src/core/email.ts             EmailProvider + createFakeEmailProvider
  src/core/clock.ts             Clock (inject time in tests)
  src/modules/identity/         service.ts (sign-up, sign-in, reset, me), mfa.ts, pin.ts, routes.ts, role-templates.ts
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
apps/web        @hotel/web      React 19 + Vite 8 PWA (staff and owner app)
  src/main.tsx                  QueryClientProvider → SessionContext → RouterProvider
  src/app/navigation.ts         NAV_ITEMS (screen + ticket per item), HOMES, homeFor/railItems/bottomBarItems
  src/app/routes.tsx            AppShell layout route; a placeholder route per screen until its ticket
  src/app/session.ts            ShellSession, toShellSession(me, propertyId), SessionActions; PREVIEW_SESSION for tests
  src/app/session-gate.tsx      SessionGate: GET /me → session or redirect to /sign-in?next=
  src/routes/auth/              S01 sign-in, /mfa, /pin; S02 sign-up; verify-email, forgot/reset password; /account/pin
  src/lib/form.ts               zodResolver, apiFieldErrors, errorMessage
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
docs/           PROGRESS, HANDOFF, VERSIONS, adr/000–023
```

Root scripts (`dev` runs api :4000 and web :5173 via `scripts/dev.mjs`; `check:size` builds web and checks the budget): `dev | check:size | openapi | openapi:check | build | lint | typecheck | format | format:check | test | check | db:generate | db:migrate | db:deploy | db:reset | seed`.

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
- **Local sign-in:** `npm run seed`, then any `<role-slug>@demo.hotel.test` (e.g. `owner@`, `front-desk@`) with `SEED_USER_PASSWORD` from `.env`. Verification and reset links are printed in the API log.
- **MFA and PINs locally:** Owner, GM and Finance demo users must set up MFA at first sign-in; generate codes from the shown key with `node --input-type=module -e "import { generate } from 'otplib'; console.log(await generate({ secret: '<key>' }))"` (run in `apps/api`). For PIN switching: set a PIN at `/account/pin` (e.g. as `front-desk@`), sign in as `dept-manager@` with "shared device" ticked, then Account menu → Switch user. Integration tests for these flows use `test/auth.ts`.
- **Lockfile:** never regenerate it with `node_modules` or the old lock present (npm/cli#4828 drops platform bindings); follow the procedure in PROGRESS decisions. After any dependency change, `grep -c "node_modules/@rolldown/binding-" package-lock.json` must print 15.

## Next step

T-013 Roles, permissions, memberships, invitations, property switcher (M1-04, M1-05, M1-08): the permission catalogue in `@hotel/shared` replacing the provisional template lists; role editing; invitations by email or phone; membership removal revoking that property’s sessions (issue 35); MFA reset (issue 37); manager password reset for phone-only staff if chosen (issue 34). The first property-scoped routes need cross-tenant cases. Then T-014 (audit). Open calls: issues 34 and 38. T-004 is still blocked on a GitHub remote; T-005 needs paid accounts (stop).
