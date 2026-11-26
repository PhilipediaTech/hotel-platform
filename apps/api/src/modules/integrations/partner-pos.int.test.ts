import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf, TEST_CONFIG } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { newApiKey } from '../../core/api-keys.ts';
import { sameSurname } from './partner-pos.ts';

// Room charges from an outside POS (Versions V2; T-167). Ada Obi is checked in to room 101 of
// P1; the hotel's POS system has a key with pos:charge.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Charge = {
  chargeId: string;
  stayId: string;
  roomNumber: string;
  totalMinor: string;
  duplicate: boolean;
};

async function hotel(scopes = ['pos:charge']) {
  const h = await inHouse(db, clock);
  const key = newApiKey(TEST_CONFIG);
  await db.apiKey.create({
    data: {
      propertyId: h.p1.id,
      name: 'Bar POS',
      prefix: key.prefix,
      tokenHash: key.tokenHash,
      scopes,
      createdById: h.gmId,
    },
  });
  const bearer = (req: request.Test) => req.set('Authorization', `Bearer ${key.token}`);
  const get = (path: string) => bearer(request(h.app).get(`/api/v1/partner${path}`));
  // Servers send no Origin.
  const post = (body: object) =>
    bearer(request(h.app).post('/api/v1/partner/room-charges')).send(body);
  const check = (over: object = {}) => ({
    roomNumber: '101',
    lastName: 'obi',
    checkNumber: 'B-1001',
    revenueCode: 'FNB',
    description: 'Bar: 2 Chapman',
    quantity: 2,
    unitAmountMinor: '500000',
    ...over,
  });
  const partnerLines = () =>
    db.folioLine.findMany({ where: { sourceType: 'PARTNER' }, include: { children: true } });
  return { ...h, get, post, check, partnerLines };
}

describe('an outside POS charging rooms', () => {
  it('lists the rooms with a guest in (no names) and the codes it can post to', async () => {
    const h = await hotel();
    const rooms = await h.get('/in-house');
    expect(rooms.status, JSON.stringify(rooms.body)).toBe(200);
    expect(rooms.body).toEqual({
      data: [
        {
          stayId: h.stayId,
          roomNumber: '101',
          arrival: '2026-11-10',
          departure: '2026-11-12',
          adults: 1,
          children: 0,
        },
      ],
    });
    expect(JSON.stringify(rooms.body)).not.toContain('Obi');
    const codes = await h.get('/revenue-codes');
    const listed = (codes.body as { data: { code: string }[] }).data.map((c) => c.code);
    expect(listed).toEqual(expect.arrayContaining(['FNB', 'MISC', 'ROOM']));
    expect(listed).not.toContain('VAT');
  });

  it('charges the room with the hotel’s taxes, once per check number', async () => {
    const h = await hotel();
    const res = await h.post(h.check());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const charge = res.body as Charge;
    expect(charge).toMatchObject({ stayId: h.stayId, roomNumber: '101', duplicate: false });
    const [line] = await h.partnerLines();
    expect(line).toMatchObject({
      id: charge.chargeId,
      folioId: h.folioId,
      kind: 'CHARGE',
      quantity: 2,
      unitAmountMinor: 500000n,
      postedById: null,
      shiftId: null,
      reason: 'Check B-1001 from an outside POS',
    });
    // Service charge, VAT and consumption tax on food and drink, as at the desk.
    expect(line?.children.length).toBe(3);
    const total = [line, ...(line?.children ?? [])].reduce(
      (s, l) => s + (l?.amountMinor ?? 0n),
      0n,
    );
    expect(charge.totalMinor).toBe(total.toString());
    expect(total).toBeGreaterThan(1000000n);
    const folio = await h.folio();
    expect(BigInt(folio.balanceMinor)).toBe(total);
    // The hotel's webhooks hear of it, and the audit log says a system posted it.
    expect(await db.domainEvent.count({ where: { type: 'folio.charge_posted' } })).toBe(1);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'folio.charge_posted', actorType: 'SYSTEM' },
    });
    expect(audit.after).toMatchObject({ checkNumber: 'B-1001', revenueCode: 'FNB' });

    // The POS sends it again (a timeout, a retry): nothing new.
    const again = await h.post(h.check());
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ chargeId: charge.chargeId, duplicate: true });
    expect(await h.partnerLines()).toHaveLength(1);
    // The same check number with other contents is a mistake, not a repeat.
    const other = await h.post(h.check({ unitAmountMinor: '600000' }));
    expect(other.status).toBe(409);
    expect(errorOf(other).code).toBe('IDEMPOTENCY_KEY_REUSED');
    // A new check posts.
    expect((await h.post(h.check({ checkNumber: 'B-1002' }))).status).toBe(201);
    expect(await h.partnerLines()).toHaveLength(2);
  });

  it('refuses a wrong surname, an empty room, a closed bill and a room over its limit', async () => {
    const h = await hotel();
    const wrong = await h.post(h.check({ lastName: 'Okafor' }));
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong).details?.issues).toEqual([
      expect.objectContaining({ path: 'body.lastName' }),
    ]);
    const empty = await h.post(h.check({ roomNumber: '999' }));
    expect(empty.status).toBe(409);
    const tax = await h.post(h.check({ revenueCode: 'VAT' }));
    expect(tax.status).toBe(400);

    await db.folio.update({ where: { id: h.folioId }, data: { creditLimitMinor: 1_000_000n } });
    const over = await h.post(h.check());
    expect(over.status).toBe(409);
    expect(errorOf(over).code).toBe('CREDIT_LIMIT_EXCEEDED');

    await db.folio.update({
      where: { id: h.folioId },
      data: { creditLimitMinor: null, status: 'SETTLED' },
    });
    const closed = await h.post(h.check());
    expect(closed.status).toBe(409);
    expect(errorOf(closed).code).toBe('STATE_TRANSITION_INVALID');
    expect(await h.partnerLines()).toHaveLength(0);
  });

  it('needs a key with pos:charge, and a session cookie never posts', async () => {
    const h = await hotel(['reservations:read']);
    const res = await h.post(h.check());
    expect(res.status).toBe(403);
    expect(errorOf(res).details).toEqual({ scope: 'pos:charge' });
    const cookie = await sessionCookie(db, h.gmId, clock);
    const withCookie = await request(h.app)
      .post('/api/v1/partner/room-charges')
      .set('Cookie', cookie)
      .set('X-Property-Id', h.p1.id)
      .send(h.check());
    expect(withCookie.status).toBe(401);
    expect(await h.partnerLines()).toHaveLength(0);
  });
});

describe('surnames', () => {
  it('ignore case, accents, spaces and punctuation', () => {
    expect(sameSurname('Obi', 'OBI')).toBe(true);
    expect(sameSurname("O'Brien-Okafor", 'obrien okafor')).toBe(true);
    expect(sameSurname('Adébáyọ̀', 'adebayo')).toBe(true);
    expect(sameSurname('Obi', 'Obiora')).toBe(false);
    expect(sameSurname('', '')).toBe(false);
  });
});
