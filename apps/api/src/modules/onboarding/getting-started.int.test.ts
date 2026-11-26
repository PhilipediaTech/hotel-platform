import { gettingStartedSteps } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';

// Getting started (Versions V2 "enhanced onboarding"; T-172): first steps by permission, done
// when the audit log shows the person did them here.

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-16T09:00:00Z');
});

type Mine = { steps: { id: string; done: boolean }[]; done: number; total: number };
type Team = { data: { user: { id: string }; done: number; total: number; missing: string[] }[] };

describe('getting started', () => {
  it('lists the steps a person’s permissions call for and ticks off what they did here', async () => {
    const h = await makeHotel(db, now);
    const c = hotelClient(db, clock, h.p1.id);
    const fd = c.as(await sessionCookie(db, h.fd.id, clock));
    const gm = c.as(await sessionCookie(db, h.gm.id, clock));
    const role = await db.role.findUniqueOrThrow({ where: { id: h.role('front-desk') } });
    const expected = gettingStartedSteps(role.permissions).map((s) => s.id);
    expect(expected).toContain('booking');

    const before = (await fd.get('/getting-started')).body as Mine;
    expect(before.steps.map((s) => s.id)).toEqual(expected);
    expect(before).toMatchObject({ done: 0, total: expected.length });

    const did = (propertyId: string, action: string) =>
      db.auditEvent.create({
        data: {
          organisationId: h.org.id,
          propertyId,
          actorType: 'USER',
          actorUserId: h.fd.id,
          action,
          entityType: 'reservation',
          entityId: crypto.randomUUID(),
        },
      });
    await did(h.p1.id, 'reservation.created');
    // Done at another property: not here.
    await did(h.p2.id, 'stay.checked_in');

    const after = (await fd.get('/getting-started')).body as Mine;
    expect(after.done).toBe(1);
    expect(after.steps.find((s) => s.id === 'booking')?.done).toBe(true);
    expect(after.steps.find((s) => s.id === 'checkIn')?.done).toBe(false);

    // Managers see how far each person here has got; the desk does not.
    const team = await gm.get('/getting-started/team');
    expect(team.status, JSON.stringify(team.body)).toBe(200);
    const desk = (team.body as Team).data.find((m) => m.user.id === h.fd.id);
    expect(desk).toMatchObject({ done: 1, total: expected.length });
    expect(desk?.missing).not.toContain('booking');
    expect((await fd.get('/getting-started/team')).status).toBe(403);
  });
});
