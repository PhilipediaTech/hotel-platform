import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../../core/auth.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { APP_ORIGIN, errorOf, TEST_CONFIG } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';

// Attendance (PRD M7-04 "As staff, I clock in and out on the shared tablet (PIN + photo) or
// my phone (restricted to property network or location, if enabled)"; M7 rules: "attendance
// and rotas are optional per type", "location-based clock-in requires the staff member's
// consent and a privacy notice"; acceptance: "clock-in outside the allowed network is
// rejected when the restriction is on"; T-138).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T07:00:00Z');
});

type Me = {
  staff: { id: string } | null;
  channel: string;
  inSince: string | null;
  blocked: string | null;
  needsPhoto: boolean;
  locationCheck: boolean;
  networkCheck: boolean;
  consentGiven: boolean;
  recent: { kind: string }[];
};
type Settings = {
  employmentTypes: string[];
  phoneAllowed: boolean;
  network: { enabled: boolean; addresses: string[] };
  location: {
    enabled: boolean;
    latitude: number | null;
    longitude: number | null;
    radiusMeters: number;
  };
  privacyNotice: string;
};
type Event = { id: string; kind: string; channel: string; photoFileId: string | null };

const HOTEL = { latitude: 6.4281, longitude: 3.4219 };
const NEAR = { latitude: 6.4285, longitude: 3.4222 }; // about 55 m
const FAR = { latitude: 6.5, longitude: 3.5 };

async function hotel() {
  const h = await inHouse(db, clock);
  const cook = await h.person('staff', h.p1.id);
  const boss = await h.person('dept-manager', h.p1.id);
  await h.ok(
    h.gm.send('/staff', {
      name: 'Bisi Cook',
      userId: cook.id,
      jobTitle: 'Cook',
      employmentType: 'MONTHLY_SALARY',
      startDate: '2026-01-05',
    }),
  );
  // The shared tablet: a manager's device session, and Bisi's PIN session under it (T-011).
  const deps = { db, config: TEST_CONFIG, clock };
  const device = await createSession(deps, {
    userId: h.gmId,
    sharedDevice: true,
    mfaPassed: true,
    kind: 'DEVICE',
    deviceLabel: 'Front desk tablet',
  });
  const pin = await createSession(deps, {
    userId: cook.id,
    sharedDevice: false,
    mfaPassed: true,
    parent: device.session,
  });
  const cookie = `sid=${pin.token}`;
  const withHeaders = (req: request.Test) =>
    req.set('Cookie', cookie).set('X-Property-Id', h.p1.id).set('Origin', APP_ORIGIN);
  const tablet = {
    get: (path: string) => withHeaders(request(h.app).get(`/api/v1${path}`)),
    send: (path: string, body: object) =>
      withHeaders(request(h.app).post(`/api/v1${path}`))
        .set('Idempotency-Key', randomUUID())
        .send(body),
  };
  const settings = async (change: (s: Settings) => Settings) => {
    const { settings: s } = await h.ok<{ settings: Settings }>(h.gm.get('/attendance/settings'));
    return h.ok<{ settings: Settings }>(h.gm.put('/attendance/settings', change(s)));
  };
  return {
    ...h,
    cookId: cook.id,
    phone: await h.as(cook.id),
    boss: await h.as(boss.id),
    tablet,
    settings,
  };
}

describe('attendance (M7-04)', () => {
  it('clocks in and out on a phone, alternating, with no checks by default', async () => {
    const h = await hotel();
    let me = await h.ok<Me>(h.phone.get('/attendance/me'));
    expect(me).toMatchObject({
      channel: 'PHONE',
      blocked: null,
      needsPhoto: false,
      networkCheck: false,
      locationCheck: false,
      inSince: null,
    });
    const clockIn = await h.ok<Event>(h.phone.send('/attendance/clock', { kind: 'IN' }));
    expect(clockIn).toMatchObject({ kind: 'IN', channel: 'PHONE', photoFileId: null });
    expect(errorOf(await h.phone.send('/attendance/clock', { kind: 'IN' })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    me = await h.ok<Me>(h.phone.get('/attendance/me'));
    expect(me.inSince).toBe('2026-11-10T07:00:00Z');
    now = new Date('2026-11-10T15:00:00Z');
    await h.ok(h.phone.send('/attendance/clock', { kind: 'OUT' }));
    expect(errorOf(await h.phone.send('/attendance/clock', { kind: 'OUT' })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    me = await h.ok<Me>(h.phone.get('/attendance/me'));
    expect(me.recent.map((e) => e.kind)).toEqual(['OUT', 'IN']);

    // No staff profile: nothing to clock against.
    expect((await h.ok<Me>(h.fd.get('/attendance/me'))).blocked).toBe('NO_PROFILE');
    expect(errorOf(await h.fd.send('/attendance/clock', { kind: 'IN' })).code).toBe(
      'VALIDATION_ERROR',
    );

    // Managers see the day and who is in.
    now = new Date('2026-11-10T16:00:00Z');
    await h.ok(h.phone.send('/attendance/clock', { kind: 'IN' }));
    expect((await h.phone.get('/attendance')).status).toBe(403);
    const day = await h.ok<{ date: string; events: unknown[]; inNow: { name: string }[] }>(
      h.boss.get('/attendance'),
    );
    expect(day.date).toBe('2026-11-10');
    expect(day.events).toHaveLength(3);
    expect(day.inNow.map((p) => p.name)).toEqual(['Bisi Cook']);
  });

  it('refuses a phone clock-in outside the allowed network when the check is on', async () => {
    const h = await hotel();
    expect((await h.phone.get('/attendance/settings')).status).toBe(403);
    const current = await h.ok<{ yourAddress: string | null }>(h.gm.get('/attendance/settings'));
    expect(current.yourAddress).toBe('127.0.0.1');

    expect(
      errorOf(
        await h.gm.put('/attendance/settings', {
          ...(await h.ok<{ settings: Settings }>(h.gm.get('/attendance/settings'))).settings,
          network: { enabled: true, addresses: ['999.1.1.1'] },
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');
    expect(
      errorOf(
        await h.gm.put('/attendance/settings', {
          ...(await h.ok<{ settings: Settings }>(h.gm.get('/attendance/settings'))).settings,
          network: { enabled: true, addresses: [] },
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');

    await h.settings((s) => ({ ...s, network: { enabled: true, addresses: ['10.0.0.0/8'] } }));
    expect((await h.ok<Me>(h.phone.get('/attendance/me'))).networkCheck).toBe(true);
    const refused = errorOf(await h.phone.send('/attendance/clock', { kind: 'IN' }));
    expect(refused.code).toBe('FORBIDDEN');
    expect(refused.details).toMatchObject({ reason: 'OUTSIDE_NETWORK' });
    expect(await db.attendanceEvent.count()).toBe(0);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'attendance.clock_refused' },
    });
    expect(audit.after).toMatchObject({ reason: 'OUTSIDE_NETWORK' });

    // On the hotel's network it goes through.
    await h.settings((s) => ({ ...s, network: { enabled: true, addresses: ['127.0.0.0/8'] } }));
    await h.ok(h.phone.send('/attendance/clock', { kind: 'IN' }));
  });

  it('checks location only with consent, and keeps the position only then', async () => {
    const h = await hotel();
    await h.settings((s) => ({
      ...s,
      network: { enabled: true, addresses: ['10.0.0.0/8'] },
      location: { enabled: true, ...HOTEL, radiusMeters: 200 },
    }));
    let me = await h.ok<Me>(h.phone.get('/attendance/me'));
    expect(me).toMatchObject({ locationCheck: true, consentGiven: false });
    const reason = async (body: object) =>
      (
        errorOf(await h.phone.send('/attendance/clock', { kind: 'IN', ...body })).details as {
          reason?: string;
        }
      ).reason;
    expect(await reason({ location: NEAR })).toBe('LOCATION_CONSENT_NEEDED');

    me = await h.ok<Me>(h.phone.post('/attendance/consent', { consent: true }));
    expect(me.consentGiven).toBe(true);
    expect(await reason({})).toBe('LOCATION_NEEDED');
    expect(await reason({ location: FAR })).toBe('OUTSIDE_AREA');
    const ok = await h.ok<{ id: string; located: boolean }>(
      h.phone.send('/attendance/clock', { kind: 'IN', location: { ...NEAR, accuracyMeters: 20 } }),
    );
    expect(ok.located).toBe(true);
    const row = await db.attendanceEvent.findUniqueOrThrow({ where: { id: ok.id } });
    expect(Number(row.latitude)).toBeCloseTo(NEAR.latitude, 4);
    expect(
      await db.auditEvent.count({ where: { action: 'attendance.location_consent_given' } }),
    ).toBe(1);
    // A refusal is audited without the position.
    const refusals = await db.auditEvent.findMany({
      where: { action: 'attendance.clock_refused' },
    });
    expect(JSON.stringify(refusals.map((r) => r.after))).not.toContain('6.5');

    // Withdrawn: location no longer accepted, nor kept.
    await h.ok(h.phone.post('/attendance/consent', { consent: false }));
    expect(
      (await db.staffProfile.findFirstOrThrow({ where: { userId: h.cookId } })).locationConsentAt,
    ).toBeNull();
    now = new Date('2026-11-10T15:00:00Z');
    expect(
      (
        errorOf(await h.phone.send('/attendance/clock', { kind: 'OUT', location: NEAR }))
          .details as { reason?: string }
      ).reason,
    ).toBe('LOCATION_CONSENT_NEEDED');
  });

  it('turns phones off, and leaves out employment types that do not clock', async () => {
    const h = await hotel();
    await h.settings((s) => ({ ...s, phoneAllowed: false }));
    expect((await h.ok<Me>(h.phone.get('/attendance/me'))).blocked).toBe('PHONE_OFF');
    expect(
      (
        errorOf(await h.phone.send('/attendance/clock', { kind: 'IN' })).details as {
          reason?: string;
        }
      ).reason,
    ).toBe('PHONE_OFF');
    // The tablet still works when phones are off.
    expect((await h.ok<Me>(h.tablet.get('/attendance/me'))).blocked).toBeNull();

    await h.settings((s) => ({
      ...s,
      phoneAllowed: true,
      employmentTypes: ['HOURLY', 'DAILY_PAID'],
    }));
    expect((await h.ok<Me>(h.phone.get('/attendance/me'))).blocked).toBe('NOT_FOR_THIS_TYPE');
    expect(errorOf(await h.phone.send('/attendance/clock', { kind: 'IN' })).code).toBe(
      'VALIDATION_ERROR',
    );
  });

  it('clocks on the shared tablet with a fresh photo of their own', async () => {
    const h = await hotel();
    const me = await h.ok<Me>(h.tablet.get('/attendance/me'));
    expect(me).toMatchObject({ channel: 'TABLET', needsPhoto: true, blocked: null });
    expect(errorOf(await h.tablet.send('/attendance/clock', { kind: 'IN' })).code).toBe(
      'VALIDATION_ERROR',
    );
    const upload = async (as: { send: (p: string, b: object) => request.Test }) =>
      (
        await h.ok<{ fileId: string }>(
          as.send('/files/upload-url', {
            entityType: 'AttendanceEvent',
            contentType: 'image/jpeg',
            sizeBytes: 50_000,
          }),
        )
      ).fileId;
    // Someone else's photo is refused.
    const gmPhoto = await upload(h.gm);
    expect(
      errorOf(await h.tablet.send('/attendance/clock', { kind: 'IN', photoFileId: gmPhoto })).code,
    ).toBe('VALIDATION_ERROR');
    const photo = await upload(h.tablet);
    const clockIn = await h.ok<Event & { deviceLabel: string | null }>(
      h.tablet.send('/attendance/clock', { kind: 'IN', photoFileId: photo }),
    );
    expect(clockIn).toMatchObject({
      channel: 'TABLET',
      photoFileId: photo,
      deviceLabel: 'Front desk tablet',
    });
    expect((await db.fileObject.findUniqueOrThrow({ where: { id: photo } })).entityId).toBe(
      clockIn.id,
    );
    // A photo is used once; an old one is refused.
    now = new Date('2026-11-10T07:05:00Z');
    expect(
      errorOf(await h.tablet.send('/attendance/clock', { kind: 'OUT', photoFileId: photo })).code,
    ).toBe('VALIDATION_ERROR');
    const stale = await upload(h.tablet);
    now = new Date('2026-11-10T07:21:00Z');
    expect(
      errorOf(await h.tablet.send('/attendance/clock', { kind: 'OUT', photoFileId: stale })).code,
    ).toBe('VALIDATION_ERROR');
    await h.ok(
      h.tablet.send('/attendance/clock', { kind: 'OUT', photoFileId: await upload(h.tablet) }),
    );
    // The network check applies to phones only.
    await h.settings((s) => ({ ...s, network: { enabled: true, addresses: ['10.0.0.0/8'] } }));
    await h.ok(
      h.tablet.send('/attendance/clock', { kind: 'IN', photoFileId: await upload(h.tablet) }),
    );
  });
});
