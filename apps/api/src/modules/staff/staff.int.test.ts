import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { runCertificationReminders } from './service.ts';

// Staff profiles (PRD M7-01 "As HR or GM, I create staff profiles (department, role, manager,
// employment type, start date, pay basis, certifications with expiry, restricted emergency
// contact)", staff.manage; M7-10 "reminders 30 days before a certification expires"; T-136).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Detail = {
  id: string;
  number: number;
  name: string;
  status: string;
  endDate: string | null;
  user: { id: string } | null;
  manager: { id: string } | null;
  department: { name: string } | null;
  employmentType: string;
  payRateMinor: string | null;
  certsDue: number;
  hasEmergencyContact: boolean;
  certifications: { id: string; name: string; expiresOn: string | null; state: string }[];
};

async function hotel() {
  const h = await inHouse(db, clock);
  const gmId = (await db.membership.findFirstOrThrow({ where: { roleId: h.role('gm') } })).userId;
  const fb = await db.department.create({
    data: { organisationId: h.org.id, propertyId: h.p1.id, code: 'FB', name: 'Food and beverage' },
  });
  const cook = await h.person('staff', h.p1.id);
  return { ...h, gmId, fb, cookId: cook.id, gm: await h.as(gmId) };
}

describe('staff profiles (M7-01, M7-10)', () => {
  it('keeps profiles, restricts the emergency contact and reminds expiring certifications', async () => {
    const h = await hotel();
    // Front desk has no staff.manage.
    expect((await h.fd.get('/staff')).status).toBe(403);

    const body = {
      name: 'Bisi Cook',
      userId: h.cookId,
      departmentId: h.fb.id,
      jobTitle: 'Cook',
      managerId: h.gmId,
      employmentType: 'MONTHLY_SALARY',
      startDate: '2026-01-05',
      payRateMinor: '15000000',
      emergency: { name: 'Kemi Cook', phone: '+2348011111111', relation: 'Sister' },
    };
    const bisi = await h.ok<Detail>(h.gm.send('/staff', body));
    expect(bisi).toMatchObject({
      number: 1,
      user: { id: h.cookId },
      manager: { id: h.gmId },
      department: { name: 'Food and beverage' },
      employmentType: 'MONTHLY_SALARY',
      payRateMinor: '15000000',
      status: 'ACTIVE',
      hasEmergencyContact: true,
    });
    // The contact is not in the profile.
    expect(JSON.stringify(bisi)).not.toContain('Kemi');
    // One profile per login.
    expect(errorOf(await h.gm.send('/staff', { ...body, name: 'Again' })).code).toBe(
      'VALIDATION_ERROR',
    );
    // A profile without a login; a manager must be a member.
    expect(
      errorOf(
        await h.gm.send('/staff', {
          name: 'Ojo Gardener',
          jobTitle: 'Gardener',
          employmentType: 'DAILY_PAID',
          startDate: '2026-03-01',
          managerId: '00000000-0000-4000-8000-000000000000',
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');
    const ojo = await h.ok<Detail>(
      h.gm.send('/staff', {
        name: 'Ojo Gardener',
        jobTitle: 'Gardener',
        employmentType: 'DAILY_PAID',
        startDate: '2026-03-01',
      }),
    );
    expect(ojo).toMatchObject({ number: 2, user: null, hasEmergencyContact: false });

    // Reading the emergency contact is audited.
    expect(await h.ok(h.gm.get(`/staff/${bisi.id}/emergency-contact`))).toEqual({
      name: 'Kemi Cook',
      phone: '+2348011111111',
      relation: 'Sister',
    });
    expect(
      await db.auditEvent.count({
        where: { action: 'staff.emergency_contact_viewed', entityId: bisi.id },
      }),
    ).toBe(1);
    // The audit never keeps the pay rate or the contact itself.
    const created = await db.auditEvent.findFirstOrThrow({
      where: { action: 'staff.created', entityId: bisi.id },
    });
    expect(JSON.stringify(created.after)).not.toMatch(/15000000|Kemi|2348011111111/);

    // Certifications: one expiring in 20 days, one fine, one expired.
    await h.ok(
      h.gm.send(`/staff/${bisi.id}/certifications`, {
        name: 'Food handler',
        reference: 'FH-123',
        issuedOn: '2025-11-30',
        expiresOn: '2026-11-30',
      }),
    );
    await h.ok(
      h.gm.send(`/staff/${bisi.id}/certifications`, { name: 'First aid', expiresOn: '2027-06-01' }),
    );
    const withCerts = await h.ok<Detail>(
      h.gm.send(`/staff/${ojo.id}/certifications`, {
        name: 'Pesticide use',
        expiresOn: '2026-11-01',
      }),
    );
    expect(withCerts.certifications.map((c) => c.state)).toEqual(['EXPIRED']);
    expect(
      errorOf(
        await h.gm.send(`/staff/${bisi.id}/certifications`, {
          name: 'Backwards',
          issuedOn: '2026-05-01',
          expiresOn: '2026-01-01',
        }),
      ).code,
    ).toBe('VALIDATION_ERROR');
    const list = await h.ok<{ data: Detail[] }>(h.gm.get('/staff'));
    expect(list.data.map((s) => [s.name, s.certsDue])).toEqual([
      ['Bisi Cook', 1],
      ['Ojo Gardener', 1],
    ]);

    // The daily worker opens one task per due certification, once per expiry date.
    expect(await runCertificationReminders(db, clock)).toBe(2);
    expect(await runCertificationReminders(db, clock)).toBe(0);
    const tasks = await db.task.findMany({ orderBy: { number: 'asc' } });
    expect(tasks.map((t) => [t.title, t.assigneeId, t.priority])).toEqual([
      ['Certification expiring: Bisi Cook, Food handler', h.gmId, 'NORMAL'],
      ['Certification expired: Ojo Gardener, Pesticide use', null, 'HIGH'],
    ]);
    // Renewed: a new date is reminded again only when it comes due.
    const bisiNow = await h.ok<Detail>(h.gm.get(`/staff/${bisi.id}`));
    const fh = bisiNow.certifications.find((c) => c.name === 'Food handler');
    await h.ok(
      h.gm.put(`/staff/${bisi.id}/certifications/${fh?.id ?? ''}`, {
        name: 'Food handler',
        expiresOn: '2027-11-30',
      }),
    );
    expect(await runCertificationReminders(db, clock)).toBe(0);

    // Leaving: an end date marks them LEFT; they drop out of the active list.
    expect(errorOf(await h.gm.patch(`/staff/${ojo.id}`, { endDate: '2026-01-01' })).code).toBe(
      'VALIDATION_ERROR',
    );
    const left = await h.ok<Detail>(h.gm.patch(`/staff/${ojo.id}`, { endDate: '2026-11-09' }));
    expect(left).toMatchObject({ status: 'LEFT', endDate: '2026-11-09' });
    expect((await h.ok<{ data: Detail[] }>(h.gm.get('/staff'))).data.map((s) => s.name)).toEqual([
      'Bisi Cook',
    ]);
    expect(
      (await h.ok<{ data: Detail[] }>(h.gm.get('/staff?status=LEFT'))).data.map((s) => s.name),
    ).toEqual(['Ojo Gardener']);
    expect(await db.auditEvent.count({ where: { action: 'staff.left', entityId: ojo.id } })).toBe(
      1,
    );

    // A certification entered by mistake is removed, with an audit row.
    const firstAid = bisiNow.certifications.find((c) => c.name === 'First aid');
    const after = await h.ok<Detail>(
      h.gm.delete(`/staff/${bisi.id}/certifications/${firstAid?.id ?? ''}`),
    );
    expect(after.certifications.map((c) => c.name)).toEqual(['Food handler']);
  });
});
