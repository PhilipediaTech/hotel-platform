import type { Me } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { SESSION_POLICY } from '../../core/auth.ts';
import { totpCode } from '../../core/mfa.ts';
import { hashPassword } from '../../core/passwords.ts';
import {
  authApi,
  cookieFrom,
  PASSWORD,
  setCookies,
  sidCookie,
  signIn,
  verifiedUser,
  type AuthApi,
} from '../../../test/auth.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { makeOrganisation, makeProperty, makeRole } from '../../../test/factories.ts';
import { errorOf } from '../../../test/helpers.ts';
import { LOCKOUT } from './service.ts';

const db = testDb();
const MINUTE = 60_000;
const PIN = '482916';

let now: Date;
const clock = () => new Date(now);
const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};
const setup = () => authApi(db, clock);
const meOf = (res: { body: unknown }) => res.body as z.output<typeof Me>;
const both = (...cookies: (string | undefined)[]) => cookies.filter(Boolean).join('; ');

/** A user with one membership in `organisationId` whose role has these settings. */
async function member(
  organisationId: string,
  role: { permissions?: string[]; requiresMfa?: boolean } = {},
  data: { email?: string; pin?: string } = {},
) {
  const user = await verifiedUser(db, data.email ? { email: data.email } : {});
  const r = await makeRole(db, organisationId);
  await db.role.update({
    where: { id: r.id },
    data: { permissions: role.permissions ?? [], requiresMfa: role.requiresMfa ?? false },
  });
  await db.membership.create({ data: { userId: user.id, organisationId, roleId: r.id } });
  if (data.pin) {
    await db.user.update({
      where: { id: user.id },
      data: { pinHash: await hashPassword(data.pin) },
    });
  }
  return { user, email: user.email ?? '', roleId: r.id };
}

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-12T09:00:10Z');
});

// ---------------------------------------------------------------------------------------

describe('MFA enforcement (M1-06)', () => {
  it('holds a user whose role requires MFA at the MFA step', async () => {
    const api = setup();
    const org = await makeOrganisation(db);
    const { email } = await member(org.id, { requiresMfa: true });
    const res = await signIn(api, email);
    expect(meOf(res).session.mfaPassed).toBe(false);
    const cookie = sidCookie(res);
    await api.get('/me', cookie).expect(200); // the app needs /me to show the MFA step
    const blocked = await api.get('/me/sessions', cookie);
    expect(blocked.status).toBe(401);
    expect(errorOf(blocked).code).toBe('MFA_REQUIRED');
  });

  it('lets a user whose roles don’t require MFA straight in', async () => {
    const api = setup();
    const org = await makeOrganisation(db);
    const { email } = await member(org.id, { requiresMfa: false });
    const res = await signIn(api, email);
    expect(meOf(res).session.mfaPassed).toBe(true);
    await api.get('/me/sessions', sidCookie(res)).expect(200);
  });

  it('applies a role that starts requiring MFA from the next sign-in', async () => {
    const api = setup();
    const org = await makeOrganisation(db);
    const { email, roleId } = await member(org.id, { requiresMfa: false });
    const before = sidCookie(await signIn(api, email));
    await db.role.update({ where: { id: roleId }, data: { requiresMfa: true } });
    await api.get('/me/sessions', before).expect(200); // the running session is not cut off
    expect(meOf(await signIn(api, email)).session.mfaPassed).toBe(false);
  });
});

/** Signs in an MFA-role user, enrols and confirms; returns the secret and recovery codes. */
async function enrolled(api: AuthApi) {
  const org = await makeOrganisation(db);
  const { user, email } = await member(org.id, { requiresMfa: true });
  const cookie = sidCookie(await signIn(api, email));
  const enrol = await api.post('/me/mfa/enrol', undefined, cookie);
  expect(enrol.status).toBe(201);
  const { secret } = enrol.body as { secret: string };
  const confirm = await api.post('/me/mfa/confirm', { code: await totpCode(secret, now) }, cookie);
  expect(confirm.status).toBe(200);
  advance(MINUTE); // move past the step used to confirm
  return {
    user,
    email,
    secret,
    recoveryCodes: (confirm.body as { recoveryCodes: string[] }).recoveryCodes,
    oldCookie: cookie,
    cookie: sidCookie(confirm),
  };
}

describe('MFA enrolment', () => {
  it('gives a secret and an otpauth link, stores the secret encrypted, not yet on', async () => {
    const api = setup();
    const org = await makeOrganisation(db);
    const { user, email } = await member(org.id, { requiresMfa: true });
    const cookie = sidCookie(await signIn(api, email));
    const res = await api.post('/me/mfa/enrol', undefined, cookie);
    expect(res.status).toBe(201);
    const { secret, otpauthUri } = res.body as { secret: string; otpauthUri: string };
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUri).toMatch(
      /^otpauth:\/\/totp\/Hotel%20Platform:.+\?secret=[A-Z2-7]+&issuer=Hotel%20Platform/,
    );
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.mfaEnabled).toBe(false);
    expect(Buffer.from(row.mfaSecretEnc ?? []).toString('latin1')).not.toContain(secret);
  });

  it('turns MFA on with a correct code, rotates the cookie and returns 10 recovery codes', async () => {
    const api = setup();
    const { user, recoveryCodes, oldCookie, cookie } = await enrolled(api);
    expect(recoveryCodes).toHaveLength(10);
    for (const code of recoveryCodes)
      expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(new Set(recoveryCodes).size).toBe(10);

    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.mfaEnabled).toBe(true);
    const stored = await db.mfaRecoveryCode.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(10);
    expect(stored.map((s) => s.codeHash)).not.toContain(recoveryCodes[0]);

    expect(cookie).not.toBe(oldCookie);
    expect(errorOf(await api.get('/me', oldCookie)).code).toBe('SESSION_EXPIRED');
    await api.get('/me/sessions', cookie).expect(200);
  });

  it('rejects a wrong set-up code without counting it towards the lockout', async () => {
    const api = setup();
    const org = await makeOrganisation(db);
    const { user, email } = await member(org.id, { requiresMfa: true });
    const cookie = sidCookie(await signIn(api, email));
    await api.post('/me/mfa/enrol', undefined, cookie);
    const res = await api.post('/me/mfa/confirm', { code: '000000' }, cookie);
    expect(res.status).toBe(400);
    expect(errorOf(res).details?.['reason']).toBe('MFA_CODE_INVALID');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).failedLogins).toBe(0);
  });

  it('refuses to enrol or confirm twice', async () => {
    const api = setup();
    const { cookie } = await enrolled(api);
    expect(errorOf(await api.post('/me/mfa/enrol', undefined, cookie)).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    expect(errorOf(await api.post('/me/mfa/confirm', { code: '123456' }, cookie)).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
  });
});

describe('MFA verification at sign-in', () => {
  it('passes MFA with the current code and rotates the cookie', async () => {
    const api = setup();
    const { secret, email } = await enrolled(api);
    const pending = sidCookie(await signIn(api, email));
    const res = await api.post('/auth/mfa/verify', { code: await totpCode(secret, now) }, pending);
    expect(res.status).toBe(200);
    expect(meOf(res).session.mfaPassed).toBe(true);
    const cookie = sidCookie(res);
    expect(cookie).not.toBe(pending);
    expect(errorOf(await api.get('/me', pending)).code).toBe('SESSION_EXPIRED');
    await api.get('/me/sessions', cookie).expect(200);
  });

  it('never accepts the same code twice', async () => {
    const api = setup();
    const { secret, email } = await enrolled(api);
    const code = await totpCode(secret, now);
    await api.post('/auth/mfa/verify', { code }, sidCookie(await signIn(api, email))).expect(200);
    const replay = await api.post(
      '/auth/mfa/verify',
      { code },
      sidCookie(await signIn(api, email)),
    );
    expect(replay.status).toBe(400);
  });

  it('accepts each recovery code once, however it is typed', async () => {
    const api = setup();
    const { recoveryCodes, email } = await enrolled(api);
    const typed = (recoveryCodes[3] ?? '').toLowerCase().replace('-', ' ');
    await api
      .post('/auth/mfa/verify', { recoveryCode: typed }, sidCookie(await signIn(api, email)))
      .expect(200);
    const again = await api.post(
      '/auth/mfa/verify',
      { recoveryCode: recoveryCodes[3] },
      sidCookie(await signIn(api, email)),
    );
    expect(again.status).toBe(400);
  });

  it('locks the account after five wrong codes and ends the half-signed-in session', async () => {
    const api = setup();
    const { email, secret } = await enrolled(api);
    const pending = sidCookie(await signIn(api, email));
    for (let i = 1; i < LOCKOUT.maxFailures; i++) {
      await api.post('/auth/mfa/verify', { code: '000000' }, pending).expect(400);
    }
    const fifth = await api.post('/auth/mfa/verify', { code: '000000' }, pending);
    expect(fifth.status).toBe(401);
    expect(errorOf(await api.get('/me', pending)).code).toBe('SESSION_EXPIRED');
    // Locked: the password no longer works either, until the lock ends.
    await api.post('/auth/sign-in', { login: email, password: PASSWORD }).expect(401);
    advance(LOCKOUT.durationMs);
    const next = sidCookie(await signIn(api, email));
    await api.post('/auth/mfa/verify', { code: await totpCode(secret, now) }, next).expect(200);
  });

  it('asks a user without MFA set up to enrol first', async () => {
    const api = setup();
    const org = await makeOrganisation(db);
    const { email } = await member(org.id, { requiresMfa: true });
    const res = await api.post(
      '/auth/mfa/verify',
      { code: '123456' },
      sidCookie(await signIn(api, email)),
    );
    expect(errorOf(res).code).toBe('STATE_TRANSITION_INVALID');
  });
});

// ---------------------------------------------------------------------------------------

describe('setting a PIN', () => {
  it('needs the current password and refuses easy PINs', async () => {
    const api = setup();
    const org = await makeOrganisation(db);
    const { user, email } = await member(org.id);
    const cookie = sidCookie(await signIn(api, email));

    const wrong = await api.put('/me/pin', { pin: PIN, password: 'not my password' }, cookie);
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong).details?.['issues']).toEqual([
      expect.objectContaining({ path: 'body.password' }),
    ]);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).failedLogins).toBe(1);

    for (const easy of ['123456', '000000', '987654', '12345a']) {
      expect((await api.put('/me/pin', { pin: easy, password: PASSWORD }, cookie)).status).toBe(
        400,
      );
    }
    await api.put('/me/pin', { pin: PIN, password: PASSWORD }, cookie).expect(204);
    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.pinHash).toMatch(/^scrypt\$/);
    expect(row.failedLogins).toBe(0);
  });
});

/** An organisation with a manager (device.manage), staff with PINs and an outsider. */
async function sharedDeviceWorld() {
  const org = await makeOrganisation(db);
  await makeProperty(db, org.id);
  const manager = await member(org.id, { permissions: ['device.manage', 'frontdesk.read'] });
  const staff = await member(org.id, { permissions: ['frontdesk.read'] }, { pin: PIN });
  const colleague = await member(org.id, { permissions: ['hk.work'] }, { pin: '730158' });
  const mfaUser = await member(org.id, { requiresMfa: true }, { pin: PIN });
  const otherOrg = await makeOrganisation(db);
  const outsider = await member(otherOrg.id, { permissions: ['frontdesk.read'] }, { pin: PIN });
  return { org, manager, staff, colleague, mfaUser, outsider };
}

/** The manager opens the tablet; returns its sid and did cookies. */
async function openDevice(api: AuthApi, managerEmail: string) {
  const res = await signIn(api, managerEmail, {
    sharedDevice: true,
    deviceLabel: 'Front desk tablet',
  });
  const did = cookieFrom(res, 'did');
  expect(did).toBeDefined();
  return { sid: sidCookie(res), did: did ?? '', me: meOf(res) };
}

describe('shared devices (M1-07)', () => {
  it('only a manager’s shared-device sign-in opens a device', async () => {
    const api = setup();
    const w = await sharedDeviceWorld();
    const { did, me } = await openDevice(api, w.manager.email);
    expect(me.session.pinSwitchAvailable).toBe(true);
    expect((await api.get('/auth/device', did)).body).toEqual({
      pinSwitchAvailable: true,
      deviceLabel: 'Front desk tablet',
    });

    const staffShared = await signIn(api, w.staff.email, { sharedDevice: true });
    expect(cookieFrom(staffShared, 'did')).toBeUndefined();
    const managerPersonal = await signIn(api, w.manager.email);
    expect(cookieFrom(managerPersonal, 'did')).toBeUndefined();
    expect((await api.get('/auth/device')).body).toEqual({
      pinSwitchAvailable: false,
      deviceLabel: null,
    });
  });

  it('switches to a staff member with their PIN, under the device session', async () => {
    const api = setup();
    const w = await sharedDeviceWorld();
    const device = await openDevice(api, w.manager.email);
    const res = await api.post(
      '/auth/pin',
      { login: w.staff.email, pin: PIN },
      both(device.sid, device.did),
    );
    expect(res.status).toBe(200);
    expect(meOf(res).user.id).toBe(w.staff.user.id);
    expect(meOf(res).session.pinSwitchAvailable).toBe(true);
    expect(cookieFrom(res, 'did')).toBeUndefined(); // the device cookie is left alone

    const child = await db.session.findFirstOrThrow({ where: { userId: w.staff.user.id } });
    const parent = await db.session.findFirstOrThrow({
      where: { userId: w.manager.user.id, sharedDevice: true },
    });
    expect(child).toMatchObject({
      parentSessionId: parent.id,
      sharedDevice: false,
      mfaPassed: true,
    });
    expect(child.expiresAt.getTime()).toBeLessThanOrEqual(parent.expiresAt.getTime());
    await api.get('/me', both(sidCookie(res), device.did)).expect(200);
  });

  it('needs the device cookie', async () => {
    const api = setup();
    const w = await sharedDeviceWorld();
    const res = await api.post('/auth/pin', { login: w.staff.email, pin: PIN });
    expect(res.status).toBe(403);
    expect(errorOf(res).details).toEqual({ reason: 'NO_SHARED_DEVICE' });
  });

  it('gives one answer for a wrong PIN, an unknown login and another organisation’s staff', async () => {
    const api = setup();
    const w = await sharedDeviceWorld();
    const { did } = await openDevice(api, w.manager.email);
    const answers = [
      await api.post('/auth/pin', { login: w.staff.email, pin: '111222' }, did),
      await api.post('/auth/pin', { login: 'nobody@example.test', pin: PIN }, did),
      await api.post('/auth/pin', { login: w.outsider.email, pin: PIN }, did),
    ];
    for (const res of answers) expect(res.status).toBe(401);
    expect(new Set(answers.map((r) => errorOf(r).message)).size).toBe(1);
  });

  it('locks the account after five wrong PINs', async () => {
    const api = setup();
    const w = await sharedDeviceWorld();
    const { did } = await openDevice(api, w.manager.email);
    for (let i = 0; i < LOCKOUT.maxFailures; i++) {
      await api.post('/auth/pin', { login: w.staff.email, pin: '111222' }, did).expect(401);
    }
    await api.post('/auth/pin', { login: w.staff.email, pin: PIN }, did).expect(401);
    advance(LOCKOUT.durationMs);
    // A fresh device sign-in: the old device session idled out during the lock.
    const reopened = await openDevice(api, w.manager.email);
    await api.post('/auth/pin', { login: w.staff.email, pin: PIN }, reopened.did).expect(200);
  });

  it('sends users whose role requires MFA to the password sign-in', async () => {
    const api = setup();
    const w = await sharedDeviceWorld();
    const { did } = await openDevice(api, w.manager.email);
    const res = await api.post('/auth/pin', { login: w.mfaUser.email, pin: PIN }, did);
    expect(res.status).toBe(403);
    expect(errorOf(res).details).toEqual({ reason: 'MFA_USERS_SIGN_IN_WITH_PASSWORD' });
  });

  it('replaces the previous PIN user, never the device', async () => {
    const api = setup();
    const w = await sharedDeviceWorld();
    const { did } = await openDevice(api, w.manager.email);
    const first = sidCookie(await api.post('/auth/pin', { login: w.staff.email, pin: PIN }, did));
    const second = await api.post(
      '/auth/pin',
      { login: w.colleague.email, pin: '730158' },
      both(first, did),
    );
    expect(second.status).toBe(200);
    expect((await api.get('/me', both(first, did))).status).toBe(401);
    expect((await api.get('/auth/device', did)).body).toMatchObject({ pinSwitchAvailable: true });
  });

  it('ends a PIN session after 30 idle minutes, while use keeps the device alive', async () => {
    const api = setup();
    const w = await sharedDeviceWorld();
    const { did } = await openDevice(api, w.manager.email);
    const sid = sidCookie(await api.post('/auth/pin', { login: w.staff.email, pin: PIN }, did));
    for (let i = 0; i < 3; i++) {
      advance(20 * MINUTE);
      await api.get('/me', both(sid, did)).expect(200); // 60 minutes in, still fine
    }
    advance(SESSION_POLICY.shared.idleMs);
    expect((await api.get('/me', both(sid, did))).status).toBe(401);
  });

  it('signing out of a PIN session leaves the device ready for the next PIN', async () => {
    const api = setup();
    const w = await sharedDeviceWorld();
    const { did } = await openDevice(api, w.manager.email);
    const sid = sidCookie(await api.post('/auth/pin', { login: w.staff.email, pin: PIN }, did));
    const out = await api.post('/auth/sign-out', undefined, both(sid, did));
    expect(out.status).toBe(204);
    expect(cookieFrom(out, 'did')).toBeUndefined();
    expect((await api.get('/auth/device', did)).body).toMatchObject({ pinSwitchAvailable: true });
    await api.post('/auth/pin', { login: w.colleague.email, pin: '730158' }, did).expect(200);
  });

  it('keeps the manager’s session and the device apart (issue 38)', async () => {
    const api = setup();
    const w = await sharedDeviceWorld();
    const device = await openDevice(api, w.manager.email);
    expect(device.sid).not.toBe(device.did.replace(/^did=/, 'sid='));
    const rows = await db.session.findMany({ where: { userId: w.manager.user.id } });
    const deviceRow = rows.find((s) => s.kind === 'DEVICE');
    const own = rows.find((s) => s.kind === 'USER');
    expect(deviceRow).toMatchObject({ sharedDevice: true, parentSessionId: null });
    expect(own).toMatchObject({ sharedDevice: false, parentSessionId: deviceRow?.id });
    // The device's token is never accepted as a sign-in, even if copied into `sid`.
    const copied = device.did.replace(/^did=/, 'sid=');
    expect(errorOf(await api.get('/me', copied)).code).toBe('SESSION_EXPIRED');
  });

  it('“Switch user” on the manager’s own session ends it and keeps the device open', async () => {
    const api = setup();
    const w = await sharedDeviceWorld();
    const device = await openDevice(api, w.manager.email);
    const out = await api.post(
      '/auth/sign-out',
      { keepDevice: true },
      both(device.sid, device.did),
    );
    expect(out.status).toBe(204);
    expect(cookieFrom(out, 'did')).toBeUndefined(); // the device cookie is untouched
    expect((await api.get('/me', device.sid)).status).toBe(401);
    expect((await api.get('/auth/device', device.did)).body).toMatchObject({
      pinSwitchAvailable: true,
    });
    await api.post('/auth/pin', { login: w.staff.email, pin: PIN }, device.did).expect(200);
  });

  it('the manager signing out closes the device and every PIN session on it', async () => {
    const api = setup();
    const w = await sharedDeviceWorld();
    const device = await openDevice(api, w.manager.email);
    const staffSid = sidCookie(
      await api.post('/auth/pin', { login: w.staff.email, pin: PIN }, device.did),
    );
    const out = await api.post('/auth/sign-out', undefined, both(device.sid, device.did));
    const cleared = setCookies(out).map((c) => c.split('=')[0] + (c.includes('=;') ? '=;' : ''));
    expect(cleared.sort()).toEqual(['did=;', 'sid=;']);
    expect((await api.get('/me', both(staffSid, device.did))).status).toBe(401);
    expect((await api.get('/auth/device', device.did)).body).toMatchObject({
      pinSwitchAvailable: false,
    });
  });

  it('stops PIN switching when the manager loses device.manage', async () => {
    const api = setup();
    const w = await sharedDeviceWorld();
    const { did } = await openDevice(api, w.manager.email);
    await db.role.update({
      where: { id: w.manager.roleId },
      data: { permissions: ['frontdesk.read'] },
    });
    const res = await api.post('/auth/pin', { login: w.staff.email, pin: PIN }, did);
    expect(errorOf(res).details).toEqual({ reason: 'NO_SHARED_DEVICE' });
  });

  it('a manager who needs MFA opens the device only after passing MFA', async () => {
    const api = setup();
    const org = await makeOrganisation(db);
    const manager = await member(org.id, { permissions: ['device.manage'], requiresMfa: true });
    // Set MFA up on a personal sign-in first.
    const personal = sidCookie(await signIn(api, manager.email));
    const { secret } = (await api.post('/me/mfa/enrol', undefined, personal)).body as {
      secret: string;
    };
    await api.post('/me/mfa/confirm', { code: await totpCode(secret, now) }, personal).expect(200);
    advance(MINUTE);

    const res = await signIn(api, manager.email, { sharedDevice: true });
    expect(cookieFrom(res, 'did')).toBeUndefined();
    const verified = await api.post(
      '/auth/mfa/verify',
      { code: await totpCode(secret, now) },
      sidCookie(res),
    );
    expect(verified.status).toBe(200);
    const did = cookieFrom(verified, 'did');
    expect(did).toBeDefined();
    expect((await api.get('/auth/device', did)).body).toMatchObject({ pinSwitchAvailable: true });
  });
});
