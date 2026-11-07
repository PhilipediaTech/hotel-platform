import { beforeEach, describe, expect, it } from 'vitest';
import { PASSWORD } from '../../../test/auth.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { PHONE_CODES_PER_HOUR } from './phone.ts';

// My phone (T-091b): set or change it with the password and a code sent by WhatsApp to the
// new number; approval codes, instant alerts and flash reports then reach it (T-024, T-091).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date();
});

const NEW_PHONE = '+2348031112222';

async function setup() {
  const h = await makeHotel(db, now);
  const c = hotelClient(db, clock, h.p1.id);
  const cookie = await sessionCookie(db, h.owner.id, clock);
  const me = c.as(cookie);
  const ask = (body: object = { phone: NEW_PHONE, password: PASSWORD }) =>
    me.post('/me/phone', body);
  const confirm = (challenge: string, code: string) =>
    me.post('/me/phone/confirm', { challenge, code });
  const lastCode = () => c.messages.sent.at(-1)?.params[0] ?? '';
  const user = () => db.user.findUniqueOrThrow({ where: { id: h.owner.id } });
  return { ...h, c, me, ask, confirm, lastCode, user };
}

const challengeOf = (res: { body: unknown }) => (res.body as { challenge: string }).challenge;

describe('my phone (T-091b)', () => {
  it('sends a WhatsApp code to the new number; the code sets it, audited; the code is never kept', async () => {
    const s = await setup();
    const asked = await s.ask();
    expect(asked.status, JSON.stringify(asked.body)).toBe(201);
    expect(s.c.messages.sent.at(-1)).toMatchObject({
      to: NEW_PHONE,
      templateName: 'approval_code',
      category: 'AUTHENTICATION',
    });
    const code = s.lastCode();
    expect(code).toMatch(/^\d{6}$/);
    expect((await s.user()).phone).toBeNull();
    const row = await db.notificationDelivery.findFirstOrThrow({
      where: { recipient: NEW_PHONE },
    });
    expect(row).toMatchObject({ status: 'SENT', templateCode: 'APPROVAL_OTP' });
    expect(JSON.stringify(row.payload)).not.toContain(code);
    expect(challengeOf(asked)).not.toContain(code);

    const done = await s.confirm(challengeOf(asked), code);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toEqual({ phone: NEW_PHONE });
    expect((await s.user()).phone).toBe(NEW_PHONE);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'user.phone_changed' } });
    expect(audit.after).toEqual({ phone: '…2222' });
    expect((await s.me.get('/me')).body).toMatchObject({ user: { phone: NEW_PHONE } });
  });

  it('needs the password; wrong passwords count towards the lockout', async () => {
    const s = await setup();
    const wrong = await s.ask({ phone: NEW_PHONE, password: 'not-the-password' });
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong).message).toBe('The password is incorrect.');
    expect((await s.user()).failedLogins).toBe(1);
    expect(s.c.messages.sent).toHaveLength(0);
    for (let i = 2; i < 5; i++) await s.ask({ phone: NEW_PHONE, password: 'nope' });
    const locked = await s.ask({ phone: NEW_PHONE, password: 'nope' });
    expect(locked.status).toBe(401);
    expect((await s.user()).lockedUntil).not.toBeNull();
  });

  it('a wrong code counts and changes nothing; an expired one, or another user’s, is refused', async () => {
    const s = await setup();
    const asked = await s.ask();
    const code = s.lastCode();
    const wrong = await s.confirm(challengeOf(asked), code === '000000' ? '111111' : '000000');
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong).message).toBe('The code is wrong.');
    expect((await s.user()).failedLogins).toBe(1);
    // A changed number in the challenge breaks its signature.
    const [claim = '', sig = ''] = challengeOf(asked).split('.');
    const other = JSON.parse(Buffer.from(claim, 'base64url').toString()) as Record<string, unknown>;
    const forged = `${Buffer.from(JSON.stringify({ ...other, p: '+2348039999999' })).toString('base64url')}.${sig}`;
    expect((await s.confirm(forged, code)).status).toBe(400);
    expect((await s.user()).phone).toBeNull();

    // Another user cannot use this challenge.
    const gm = s.c.as(await sessionCookie(db, s.gm.id, clock));
    const theirs = await gm.post('/me/phone/confirm', { challenge: challengeOf(asked), code });
    expect(errorOf(theirs).message).toMatch(/expired/);

    now = new Date(now.getTime() + 11 * 60_000);
    const late = s.c.as(await sessionCookie(db, s.owner.id, clock));
    const expired = await late.post('/me/phone/confirm', { challenge: challengeOf(asked), code });
    expect(errorOf(expired).message).toBe('The code has expired: ask for a new one.');
    expect((await s.user()).phone).toBeNull();
  });

  it('refuses a number another account has, before and after the code', async () => {
    const s = await setup();
    await db.user.update({ where: { id: s.fd.id }, data: { phone: NEW_PHONE } });
    const taken = await s.ask();
    expect(errorOf(taken).message).toBe('This number belongs to another account.');
    await db.user.update({ where: { id: s.fd.id }, data: { phone: null } });

    const asked = await s.ask();
    await db.user.update({ where: { id: s.fd.id }, data: { phone: NEW_PHONE } });
    const late = await s.confirm(challengeOf(asked), s.lastCode());
    expect(errorOf(late).message).toBe('This number belongs to another account.');
    expect((await s.user()).phone).toBeNull();
  });

  it('WhatsApp refusing the number is a field error; not answering is a 502; at most 5 codes an hour', async () => {
    const s = await setup();
    s.c.messages.failNext(1, true);
    const refused = await s.ask();
    expect(refused.status).toBe(400);
    expect(errorOf(refused).message).toMatch(/could not deliver/);
    s.c.messages.failNext(1);
    const down = await s.ask();
    expect(down.status).toBe(502);
    expect(errorOf(down).code).toBe('MESSAGE_PROVIDER_UNAVAILABLE');
    for (let i = 2; i < PHONE_CODES_PER_HOUR; i++) expect((await s.ask()).status).toBe(201);
    const over = await s.ask();
    expect(over.status).toBe(429);
    expect(errorOf(over).code).toBe('RATE_LIMITED');
  });
});
