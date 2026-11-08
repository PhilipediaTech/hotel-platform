import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import type { Logger } from 'pino';
import type { FileStore } from '../../core/files.ts';
import { alertDetail } from '../owner/notify.ts';
import { idPurgeJob } from './check-in.ts';
import { raiseVisitorAlerts } from './visitors.ts';

// The visitor register (PRD M14-04, M14-05; T-057): sign in against a checked-in guest, sign
// out, and the leakage alert for a visitor still in after the cut-off with no extra person
// added. Lagos is UTC+1: the default 23:00 cut-off is 22:00Z.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T15:00:00Z');
});

type Visitor = {
  id: string;
  stayId: string;
  guestName: string;
  roomNumber: string | null;
  name: string;
  phone: string | null;
  idFileId: string | null;
  signedInAt: string;
  signedOutAt: string | null;
};
type List = { date: string; data: Visitor[] };

async function hotel() {
  const h = await inHouse(db, clock);
  const list = (query = '', as = h.fd) => h.ok<List>(as.get(`/visitors${query}`));
  const signIn = (body: object = {}, as = h.fd) =>
    as.send('/visitors', { stayId: h.stayId, name: 'Tunde Bakare', ...body });
  const signOut = (id: string, as = h.fd) => as.send(`/visitors/${id}/sign-out`, {});
  const alerts = () =>
    db.leakageAlert.findMany({
      where: { ruleCode: 'VISITOR_OVERSTAY' },
      orderBy: { raisedAt: 'asc' },
    });
  return { ...h, list, signIn, signOut, alerts };
}

describe('visitor register (M14-04)', () => {
  it('signs a visitor in against the guest and out again; the audit keeps both', async () => {
    const h = await hotel();
    const res = await h.signIn({ phone: '+2348031234567', note: 'Brother' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const v = res.body as Visitor;
    expect(v).toMatchObject({
      stayId: h.stayId,
      guestName: 'Ada Obi',
      roomNumber: '101',
      name: 'Tunde Bakare',
      phone: '+2348031234567',
      signedInAt: '2026-11-10T15:00:00Z',
      signedOutAt: null,
    });
    expect((await h.list()).data.map((x) => x.id)).toEqual([v.id]);

    now = new Date('2026-11-10T16:30:00Z');
    const out = await h.ok<Visitor>(h.signOut(v.id));
    expect(out.signedOutAt).toBe('2026-11-10T16:30:00Z');
    // They stay on today's list; a second sign-out is refused.
    expect((await h.list()).data[0]?.signedOutAt).toBe('2026-11-10T16:30:00Z');
    const again = await h.signOut(v.id);
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('STATE_TRANSITION_INVALID');
    expect(
      (
        await db.auditEvent.findMany({ where: { entityId: v.id }, orderBy: { occurredAt: 'asc' } })
      ).map((e) => e.action),
    ).toEqual(['visitor.signed_in', 'visitor.signed_out']);
  });

  it('lists everyone still in, and those who left by the day they came', async () => {
    const h = await hotel();
    const stayed = await h.ok<Visitor>(h.signIn({ name: 'Still In' }));
    const left = await h.ok<Visitor>(h.signIn({ name: 'Gone Home' }));
    await h.ok(h.signOut(left.id));

    now = new Date('2026-11-11T10:00:00Z');
    const fd = await h.as(h.fdId);
    const today = await h.list('', fd);
    expect(today.date).toBe('2026-11-11');
    expect(today.data.map((x) => x.id)).toEqual([stayed.id]);
    const yesterday = await h.list('?date=2026-11-10', fd);
    expect(yesterday.data.map((x) => x.name).sort()).toEqual(['Gone Home', 'Still In']);
  });

  it('only for a checked-in guest, only with visitor.log; the ID photo must be a visitor file', async () => {
    const h = await hotel();
    const hk = await h.person('hk-attendant', h.p1.id);
    const attendant = await h.as(hk.id);
    expect((await h.signIn({}, attendant)).status).toBe(403);
    expect((await attendant.get('/visitors')).status).toBe(403);

    const res = await h.signIn({ idFileId: '0d0d0d0d-0000-4000-8000-000000000099' });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({
      issues: [expect.objectContaining({ path: 'body.idFileId' })],
    });

    await db.stay.update({
      where: { id: h.stayId },
      data: { status: 'CHECKED_OUT', checkedOutAt: now },
    });
    const gone = await h.signIn();
    expect(gone.status).toBe(409);
    expect(errorOf(gone)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      details: { status: 'CHECKED_OUT' },
    });
  });

  it('an ID photo goes on the property’s ID retention period', async () => {
    const h = await hotel();
    const file = await db.fileObject.create({
      data: {
        organisationId: h.org.id,
        propertyId: h.p1.id,
        entityType: 'Visitor',
        storageKey: 'visitors/one.jpg',
        contentType: 'image/jpeg',
        sizeBytes: 100,
        uploadedById: h.fdId,
      },
    });
    const v = await h.ok<Visitor>(h.signIn({ idFileId: file.id }));
    expect(v.idFileId).toBe(file.id);
    const row = await db.visitor.findUniqueOrThrow({ where: { id: v.id } });
    expect(row.purgeAfter).not.toBeNull();
    expect((row.purgeAfter as Date) > now).toBe(true);

    // Nothing goes before the date; after it the photo goes and the visit stays on record.
    const deleted: string[] = [];
    const store = {
      delete: (key: string) => {
        deleted.push(key);
        return Promise.resolve();
      },
    } as unknown as FileStore;
    const logger = { info: () => undefined } as unknown as Logger;
    const job = idPurgeJob({ store });
    await job.run({}, { db, clock, logger });
    expect(deleted).toEqual([]);

    now = new Date((row.purgeAfter as Date).getTime() + 86_400_000);
    await job.run({}, { db, clock, logger });
    expect(deleted).toEqual(['visitors/one.jpg']);
    expect(await db.fileObject.count({ where: { id: file.id } })).toBe(0);
    expect(await db.visitor.findUniqueOrThrow({ where: { id: v.id } })).toMatchObject({
      name: 'Tunde Bakare',
      idFileId: null,
    });
  });

  it('words the owner’s WhatsApp alert', () => {
    expect(
      alertDetail(
        {
          ruleCode: 'VISITOR_OVERSTAY',
          evidence: { visitor: 'Tunde Bakare', guest: 'Ada Obi', room: '101', cutoffHour: 23 },
        },
        null,
        'NGN',
      ),
    ).toBe('Tunde Bakare is still signed in with Ada Obi in room 101 after the 23:00 cut-off.');
  });
});

describe('visitor past the cut-off (M14-05)', () => {
  it('raises one alert once a visitor is still in after 23:00, with the evidence', async () => {
    const h = await hotel();
    const v = await h.ok<Visitor>(h.signIn());
    now = new Date('2026-11-10T21:30:00Z'); // 22:30 in Lagos
    expect(await raiseVisitorAlerts(db, clock)).toBe(0);

    now = new Date('2026-11-10T22:05:00Z'); // 23:05
    expect(await raiseVisitorAlerts(db, clock)).toBe(1);
    expect(await raiseVisitorAlerts(db, clock)).toBe(0);
    const [alert] = await h.alerts();
    expect(alert).toMatchObject({ entityType: 'visitor', entityId: v.id, severity: 'HIGH' });
    expect(alert?.evidence).toMatchObject({
      visitor: 'Tunde Bakare',
      guest: 'Ada Obi',
      room: '101',
      signedInAt: '2026-11-10T15:00:00Z',
      cutoffHour: 23,
    });
  });

  it('still counts through the small hours and the next day; not once signed out', async () => {
    const h = await hotel();
    const early = await h.ok<Visitor>(h.signIn({ name: 'Left In Time' }));
    await h.ok(h.signOut(early.id));
    await h.ok(h.signIn({ name: 'Night Owl' }));
    now = new Date('2026-11-11T01:30:00Z'); // 02:30 the next morning
    expect(await raiseVisitorAlerts(db, clock)).toBe(1);
    expect((await h.alerts()).map((a) => (a.evidence as { visitor: string }).visitor)).toEqual([
      'Night Owl',
    ]);
  });

  it('an extra person added since the visitor came answers it; one added before does not', async () => {
    const h = await hotel();
    const type = await db.stay.findUniqueOrThrow({ where: { id: h.stayId } });
    await db.roomType.update({ where: { id: type.roomTypeId }, data: { maxOccupancy: 4 } });
    await h.ok(
      h.fd.send(`/stays/${h.stayId}/occupants`, {
        firstName: 'Early',
        lastName: 'Bird',
        kind: 'ADULT',
      }),
    );
    now = new Date('2026-11-10T16:00:00Z');
    await h.ok(h.signIn({ name: 'Bola Obi' }));

    now = new Date('2026-11-10T17:00:00Z');
    await h.ok(
      h.fd.send(`/stays/${h.stayId}/occupants`, {
        firstName: 'Bola',
        lastName: 'Obi',
        kind: 'ADULT',
      }),
    );
    now = new Date('2026-11-10T22:05:00Z');
    expect(await raiseVisitorAlerts(db, clock)).toBe(0);

    // Taken off again: the visitor counts once more.
    const person = await db.stayOccupant.findFirstOrThrow({ where: { firstName: 'Bola' } });
    await db.stayOccupant.update({
      where: { id: person.id },
      data: { removedAt: now, removedById: h.fdId },
    });
    expect(await raiseVisitorAlerts(db, clock)).toBe(1);
  });

  it('the hotel sets the cut-off or switches the rule off; a checked-out stay is ignored', async () => {
    const h = await hotel();
    await h.ok(h.signIn());
    await db.leakageRule.create({
      data: { propertyId: h.p1.id, code: 'VISITOR_OVERSTAY', params: { cutoffHour: 20 } },
    });
    now = new Date('2026-11-10T19:30:00Z'); // 20:30 in Lagos
    await db.leakageRule.update({
      where: { propertyId_code: { propertyId: h.p1.id, code: 'VISITOR_OVERSTAY' } },
      data: { enabled: false },
    });
    expect(await raiseVisitorAlerts(db, clock)).toBe(0);
    await db.stay.update({
      where: { id: h.stayId },
      data: { status: 'CHECKED_OUT', checkedOutAt: now },
    });
    await db.leakageRule.update({
      where: { propertyId_code: { propertyId: h.p1.id, code: 'VISITOR_OVERSTAY' } },
      data: { enabled: true },
    });
    expect(await raiseVisitorAlerts(db, clock)).toBe(0);
    await db.stay.update({
      where: { id: h.stayId },
      data: { status: 'CHECKED_IN', checkedOutAt: null },
    });
    expect(await raiseVisitorAlerts(db, clock)).toBe(1);
  });
});
