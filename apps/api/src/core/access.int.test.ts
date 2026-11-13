import { API_ROUTES, type RouteContract } from '@hotel/shared';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../test/db.ts';
import { makeOrganisation, makeProperty, makeRole, makeUser } from '../../test/factories.ts';
import { APP_ORIGIN, buildTestApp, errorOf, TEST_CONFIG } from '../../test/helpers.ts';
import { sessionCookie } from '../../test/tenancy.ts';
import { BODY_LIMIT } from '../app.ts';
import { ORIGIN_CHECK_EXEMPT } from './csrf.ts';

// Security pass (T-102; PRD NFR "OWASP ASVS level 2"; docs/SECURITY.md). Route-wide sweeps
// over every route in API_ROUTES, so a route added later is checked without anyone writing
// a test for it: sign-in, CSRF, permissions, support sessions read-only, platform staff only,
// plus the reviewed lists of routes that are public or open to every member. Cross-tenant
// isolation of every property-scoped route is the tenancy suite (tenancy.int.test.ts).

const db = testDb();
const ROUTES = Object.values(API_ROUTES) as RouteContract[];
const EVIL_ORIGIN = 'https://evil.example';

/**
 * Reviewed in T-102: reachable without signing in. Each is either how someone signs in,
 * a link from an email, a device sign-in, a signed webhook, or the API description.
 */
const PUBLIC_ROUTES = [
  'getOpenApiDocument',
  'signUp',
  'verifyEmail',
  'resendVerification',
  'signIn',
  'signOut',
  'requestPasswordReset',
  'resetPassword',
  'getDevice',
  'pinSwitch',
  'previewInvitation',
  'acceptInvitation',
  'paymentWebhook',
  'whatsappWebhookVerify',
  'whatsappWebhook',
  // Reviewed in T-112: the booking page. Only switched-on, live hotels; a link is a secret.
  'getPublicProperty',
  'getPublicAvailability',
  'createPublicBooking',
  'getPublicBooking',
  'cancelPublicBooking',
  // Reviewed in T-114: online check-in. Each needs the guest's secret link.
  'getPublicCheckIn',
  'createPublicIdUpload',
  'submitPublicCheckIn',
  'payPublicBalance',
];

/** Reviewed in T-102: reachable after the password, before MFA (to get through MFA). */
const PENDING_MFA_ROUTES = ['getMe', 'verifyMfa', 'enrolMfa', 'confirmMfa'];

/**
 * Reviewed in T-102: property routes with no permission in the contract, open to every
 * member of the property. Reference lists every role picks from, or a check of its own in
 * the service.
 */
const MEMBER_ROUTES: Record<string, string> = {
  listApprovals: 'only the requests the caller made or may decide (visibleTo)',
  getApproval: 'only a request the caller made or may decide (visibleTo)',
  createFileUploadUrl: 'the file kind’s own permission (files/service.ts)',
  getFileDownloadUrl: 'the file kind’s read permission (files/service.ts)',
  listRoomTypes: 'reference list',
  listRooms: 'reference list',
  setHkStatus: 'which statuses the caller may set (rooms/service.ts)',
  listRevenueCodes: 'reference list',
  listTaxRules: 'reference list',
  listCancellationPolicies: 'reference list',
  listRatePlans: 'reference list',
  getRateCalendar: 'reference list',
  listPackages: 'reference list',
  listCompanies: 'reference list (booking for a company)',
  getCompany: 'reference list (booking for a company)',
  listStatusReports: 'housekeeping status reports, mayReport in the service',
  listAssets: 'asset register, mayRead in the service (asset.manage or wo.work)',
  getAsset: 'asset register, mayRead in the service (asset.manage or wo.work)',
  submitStatusReport: 'mayReport (housekeeping/status-reports.ts)',
  listTasks: 'only tasks the caller may see (loadVisible)',
  createTask: 'task.create or task.report (tasks/service.ts)',
  getTaskFormOptions: 'reference list',
  getTask: 'only a task the caller may see (loadVisible)',
  addTaskComment: 'only a task the caller may see (loadVisible)',
  listTaskTemplates: 'reference list',
};

const sorted = (xs: string[]) => [...xs].sort();
const fakeId = () => crypto.randomUUID();

function send(
  app: App,
  route: RouteContract,
  opts: { cookie?: string; propertyId?: string; origin?: string | null; body?: object } = {},
) {
  const path = `/api/v1${route.path.replace(/\{(\w+)\}/g, (_, name: string) =>
    name === 'provider' ? 'paystack' : fakeId(),
  )}`;
  const req = request(app)[route.method](path);
  if (opts.cookie) req.set('Cookie', opts.cookie);
  if (opts.propertyId && route.propertyScoped) req.set('X-Property-Id', opts.propertyId);
  const origin = opts.origin === undefined ? APP_ORIGIN : opts.origin;
  if (origin !== null) req.set('Origin', origin);
  if (route.idempotent) req.set('Idempotency-Key', fakeId());
  if (route.ifMatch) req.set('If-Match', '"1"');
  return route.method === 'get' ? req : req.send(opts.body ?? {});
}

/** Collects every route that misbehaves, so one run lists them all. */
async function sweep(
  routes: RouteContract[],
  check: (route: RouteContract) => Promise<string | null>,
) {
  const failures: string[] = [];
  for (const route of routes) {
    const problem = await check(route);
    if (problem) failures.push(`${route.operationId} (${route.method} ${route.path}): ${problem}`);
  }
  return failures;
}

let app: App;
let propertyId: string;
/** A member of the property whose role holds no permission at all. */
let memberCookie: string;
/** A platform admin reading the group through an open support session. */
let supportCookie: string;

beforeAll(async () => {
  await resetDb(db);
  app = buildTestApp(undefined, { db }).app;
  const org = await makeOrganisation(db);
  const property = await makeProperty(db, org.id);
  propertyId = property.id;
  const role = await makeRole(db, org.id);
  const member = await makeUser(db);
  await db.user.update({ where: { id: member.id }, data: { status: 'ACTIVE' } });
  await db.membership.create({
    data: { userId: member.id, organisationId: org.id, propertyId, roleId: role.id },
  });
  memberCookie = await sessionCookie(db, member.id);

  const admin = await makeUser(db, { email: TEST_CONFIG.platformAdminEmails[0] ?? '' });
  await db.user.update({
    where: { id: admin.id },
    data: { status: 'ACTIVE', mfaEnabled: true, mfaSecretEnc: Buffer.alloc(32, 1) },
  });
  await db.supportSession.create({
    data: {
      organisationId: org.id,
      adminUserId: admin.id,
      reason: 'Security pass sweep',
      expiresAt: new Date(Date.now() + 30 * 60_000),
    },
  });
  supportCookie = await sessionCookie(db, admin.id);
});

describe('reviewed route lists (T-102)', () => {
  it('only the reviewed routes are public', () => {
    const open = ROUTES.filter((r) => r.auth === 'none').map((r) => r.operationId);
    expect(sorted(open), 'review a new public route, then add it to PUBLIC_ROUTES').toEqual(
      sorted(PUBLIC_ROUTES),
    );
  });

  it('only the reviewed routes are reachable before MFA', () => {
    const pending = ROUTES.filter((r) => r.allowPendingMfa).map((r) => r.operationId);
    expect(sorted(pending)).toEqual(sorted(PENDING_MFA_ROUTES));
  });

  it('only the reviewed property routes go without a permission', () => {
    const open = ROUTES.filter((r) => r.propertyScoped && !r.permission).map((r) => r.operationId);
    expect(
      sorted(open),
      'give the route a permission, or review it and add it to MEMBER_ROUTES',
    ).toEqual(sorted(Object.keys(MEMBER_ROUTES)));
  });

  it('skips the Origin check only for signed webhooks and the local file links', () => {
    expect(ORIGIN_CHECK_EXEMPT).toEqual(['/api/v1/webhooks/', '/api/v1/local-files/']);
    const exempt = ROUTES.filter((r) =>
      `/api/v1${r.path}`.startsWith(ORIGIN_CHECK_EXEMPT[0] ?? ''),
    );
    expect(exempt.every((r) => r.auth === 'none')).toBe(true);
  });
});

describe('route-wide sweeps (T-102)', () => {
  it('every signed-in route answers 401 without a session', async () => {
    const failures = await sweep(
      ROUTES.filter((r) => r.auth !== 'none'),
      async (route) => {
        const res = await send(app, route, { propertyId });
        return res.status === 401 && errorOf(res).code === 'UNAUTHENTICATED'
          ? null
          : `answered ${res.status}`;
      },
    );
    expect(failures).toEqual([]);
  });

  it('every state-changing route refuses a missing or foreign Origin (CSRF)', async () => {
    const writes = ROUTES.filter(
      (r) =>
        r.method !== 'get' &&
        !ORIGIN_CHECK_EXEMPT.some((prefix) => `/api/v1${r.path}`.startsWith(prefix)),
    );
    expect(writes.length).toBeGreaterThan(100);
    const failures = await sweep(writes, async (route) => {
      for (const origin of [null, EVIL_ORIGIN]) {
        const res = await send(app, route, { cookie: memberCookie, propertyId, origin });
        if (res.status !== 403 || errorOf(res).details?.reason !== 'ORIGIN_NOT_ALLOWED') {
          return `Origin ${origin ?? '(none)'} answered ${res.status}`;
        }
      }
      return null;
    });
    expect(failures).toEqual([]);
  });

  it('every route with a permission refuses a member without it, before reading the request', async () => {
    const guarded = ROUTES.filter((r) => r.permission);
    expect(guarded.length).toBeGreaterThan(100);
    const failures = await sweep(guarded, async (route) => {
      const res = await send(app, route, { cookie: memberCookie, propertyId });
      const error = res.status === 403 ? errorOf(res) : undefined;
      return error?.code === 'FORBIDDEN' && error.details?.permission === route.permission
        ? null
        : `answered ${res.status} ${error?.code ?? JSON.stringify(res.body).slice(0, 80)}`;
    });
    expect(failures).toEqual([]);
  });

  it('a support session changes nothing on any property route', async () => {
    const writes = ROUTES.filter((r) => r.propertyScoped && r.method !== 'get');
    const failures = await sweep(writes, async (route) => {
      const res = await send(app, route, { cookie: supportCookie, propertyId });
      return res.status === 403 && errorOf(res).details?.support === true
        ? null
        : `answered ${res.status}`;
    });
    expect(failures).toEqual([]);
    // …while it can still read (the support session works).
    const arrivals = ROUTES.find((r) => r.operationId === 'listArrivals');
    if (!arrivals) throw new Error('listArrivals missing');
    expect((await send(app, arrivals, { cookie: supportCookie, propertyId })).status).toBe(200);
  });

  it('every platform route refuses hotel staff', async () => {
    const platform = ROUTES.filter((r) => r.platform);
    expect(platform.length).toBeGreaterThan(5);
    // The platform router guards /platform; a platform route elsewhere would slip past it.
    expect(platform.filter((r) => !r.path.startsWith('/platform/'))).toEqual([]);
    const failures = await sweep(platform, async (route) => {
      const res = await send(app, route, { cookie: memberCookie });
      return res.status === 403 ? null : `answered ${res.status}`;
    });
    expect(failures).toEqual([]);
  });
});

describe('HTTP hardening (T-102)', () => {
  it('sends the security headers and no framework banner', async () => {
    const res = await request(app).get('/api/v1/me');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'self'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('gives CORS access only to the app and booking site', async () => {
    const ok = await request(app).get('/api/v1/me').set('Origin', APP_ORIGIN);
    expect(ok.headers['access-control-allow-origin']).toBe(APP_ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const site = await request(app).get('/api/v1/me').set('Origin', TEST_CONFIG.siteOrigin);
    expect(site.headers['access-control-allow-origin']).toBe(TEST_CONFIG.siteOrigin);
    const evil = await request(app).get('/api/v1/me').set('Origin', EVIL_ORIGIN);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it(`refuses a body over ${BODY_LIMIT} before reading it`, async () => {
    const res = await request(app)
      .post('/api/v1/auth/sign-in')
      .set('Origin', APP_ORIGIN)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ email: 'x@example.test', password: 'x'.repeat(110_000) }));
    // body-parser's 413 is mapped to the error envelope (core/errors.ts).
    expect(res.status).toBe(400);
    expect(errorOf(res).message).toMatch(/too large/);
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|node_modules/);
  });

  it('answers an unknown API path with the error envelope and no stack trace', async () => {
    const res = await request(app).get('/api/v1/no-such-route');
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe('NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toMatch(/stack|at \w+ \(/);
  });
});
