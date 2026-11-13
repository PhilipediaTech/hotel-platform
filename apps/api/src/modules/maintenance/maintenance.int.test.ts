import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { DEPARTMENT_TEMPLATES } from '../identity/role-templates.ts';

// Maintenance (PRD M5-08 "As maintenance, I work a work order through its states, log parts
// and time, and attach after photos"; M5-09 "As a manager, I keep an asset register with
// location, serial, warranty, vendor and service history"; tab 4 row "Maintenance"; T-130).

const db = testDb();
let now: Date;
const clock = () => new Date(now);

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

type Asset = {
  id: string;
  tag: string;
  name: string;
  category: string;
  location: string | null;
  room: { id: string; number: string } | null;
  warrantyUntil: string | null;
  underWarranty: boolean;
  costMinor: string | null;
  status: string;
  openJobs: number;
  history: { number: number; status: string; labourMinutes: number; costMinor: string }[];
  totals: { jobs: number; labourMinutes: number; costMinor: string };
};
type WorkOrder = {
  parts: { name: string; quantity: number; costMinor: string }[];
  labourMinutes: number;
  vendorName: string | null;
  partsCostMinor: string;
  vendorCostMinor: string;
  costMinor: string;
};
type Task = {
  id: string;
  number: number;
  title: string;
  status: string;
  room: { number: string } | null;
  asset: { id: string; tag: string; name: string } | null;
  workOrder: WorkOrder | null;
  canLogWork: boolean;
};

/** Ada in 101 (inHouse); departments; two maintenance technicians and an attendant. */
async function hotel() {
  const h = await inHouse(db, clock);
  await db.department.createMany({
    data: DEPARTMENT_TEMPLATES.map((d) => ({
      organisationId: h.org.id,
      propertyId: h.p1.id,
      ...d,
    })),
  });
  const r101 = await db.room.findFirstOrThrow({ where: { number: '101', propertyId: h.p1.id } });
  const femi = await h.person('maintenance', h.p1.id);
  const gbenga = await h.person('maintenance', h.p1.id);
  const attendant = await h.person('hk-attendant', h.p1.id);
  const fault = (
    await h.ok<{ data: { id: string; type: string }[] }>(h.gm.get('/task-templates'))
  ).data.find((t) => t.type === 'FAULT');
  if (!fault) throw new Error('no FAULT template');
  return {
    ...h,
    r101,
    femiId: femi.id,
    femi: await h.as(femi.id),
    gbenga: await h.as(gbenga.id),
    attendant: await h.as(attendant.id),
    faultTemplateId: fault.id,
  };
}

const AC = {
  tag: 'AC-101',
  name: 'Split AC 1.5HP',
  category: 'Air conditioning',
  serial: 'LG-88231',
  vendor: 'Cool Breeze Ltd',
  warrantyUntil: '2027-03-31',
  costMinor: '45000000',
};

describe('asset register (M5-09)', () => {
  it('keeps assets with location, serial, warranty and vendor', async () => {
    const h = await hotel();
    // Attendants can't see the register; front desk can't add to it.
    expect((await h.attendant.get('/assets')).status).toBe(403);
    expect((await h.fd.send('/assets', AC)).status).toBe(403);

    const ac = await h.ok<Asset>(h.femi.send('/assets', { ...AC, roomId: h.r101.id }));
    expect(ac).toMatchObject({
      tag: 'AC-101',
      room: { number: '101' },
      warrantyUntil: '2027-03-31',
      underWarranty: true,
      costMinor: '45000000',
      status: 'IN_SERVICE',
      openJobs: 0,
      history: [],
      totals: { jobs: 0, labourMinutes: 0, costMinor: '0' },
    });
    await h.ok(
      h.femi.send('/assets', {
        tag: 'GEN-1',
        name: 'Perkins 60kVA generator',
        category: 'Generator',
        location: 'Generator house',
        warrantyUntil: '2026-01-31',
      }),
    );

    // The tag is unique in the property; a room of another property is refused.
    expect(errorOf(await h.femi.send('/assets', AC))).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: { issues: [{ path: 'body.tag' }] },
    });
    const other = await db.room.findFirst({ where: { propertyId: { not: h.p1.id } } });
    if (other) {
      expect(
        errorOf(await h.femi.send('/assets', { ...AC, tag: 'X', roomId: other.id })).code,
      ).toBe('VALIDATION_ERROR');
    }

    const list = await h.ok<{ data: Asset[]; categories: string[] }>(h.femi.get('/assets'));
    expect(list.data.map((a) => [a.tag, a.underWarranty])).toEqual([
      ['AC-101', true],
      ['GEN-1', false],
    ]);
    expect(list.categories).toContain('Plumbing');
    const found = await h.ok<{ data: Asset[] }>(h.femi.get('/assets?q=perkins'));
    expect(found.data.map((a) => a.tag)).toEqual(['GEN-1']);

    const moved = await h.ok<Asset>(
      h.femi.patch(`/assets/${ac.id}`, {
        roomId: null,
        location: 'Store',
        status: 'OUT_OF_SERVICE',
      }),
    );
    expect(moved).toMatchObject({ room: null, location: 'Store', status: 'OUT_OF_SERVICE' });
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'asset.updated' } });
    expect(audit.after).toMatchObject({ location: 'Store', status: 'OUT_OF_SERVICE' });
    expect((await h.gbenga.get(`/assets/${ac.id}`)).status).toBe(200);
  });
});

describe('work orders (M5-08)', () => {
  it('logs parts, time and vendor cost on a job, and builds the asset history', async () => {
    const h = await hotel();
    const ac = await h.ok<Asset>(h.femi.send('/assets', { ...AC, roomId: h.r101.id }));

    // A fault on the asset, given to Femi; it takes the asset's room and name.
    const job = await h.ok<Task>(
      h.gm.send('/tasks', {
        templateId: h.faultTemplateId,
        assetId: ac.id,
        assigneeId: h.femiId,
        description: 'Not cooling',
      }),
    );
    expect(job).toMatchObject({
      title: 'Fault: Split AC 1.5HP',
      room: { number: '101' },
      asset: { tag: 'AC-101' },
      workOrder: null,
    });
    const asFemi = await h.ok<Task>(h.femi.get(`/tasks/${job.id}`));
    expect(asFemi.canLogWork).toBe(true);
    await h.ok(h.femi.send(`/tasks/${job.id}/acknowledge`));
    await h.ok(h.femi.send(`/tasks/${job.id}/start`));

    const log = (who: typeof h.femi, body: object) =>
      who.send(`/work-orders/${job.id}/detail`, body);
    const body = {
      parts: [
        { name: 'Capacitor 35µF', quantity: 1, costMinor: '850000' },
        { name: 'R22 gas (kg)', quantity: 2, costMinor: '1200000' },
      ],
      labourMinutes: 90,
      vendorName: 'Cool Breeze Ltd',
      vendorCostMinor: '1500000',
    };
    // Only the assignee or a manager (another technician can't see the job); a vendor's
    // charge needs the vendor's name.
    expect((await log(h.gbenga, body)).status).toBe(404);
    expect((await log(h.attendant, body)).status).toBe(403);
    expect(errorOf(await log(h.femi, { ...body, vendorName: null })).code).toBe('VALIDATION_ERROR');
    const saved = await h.ok<{ workOrder: WorkOrder; asset: { tag: string } | null }>(
      log(h.femi, body),
    );
    expect(saved.workOrder).toEqual({
      parts: body.parts,
      labourMinutes: 90,
      vendorName: 'Cool Breeze Ltd',
      partsCostMinor: '2050000',
      vendorCostMinor: '1500000',
      costMinor: '3550000',
    });
    expect(saved.asset).toMatchObject({ tag: 'AC-101' });
    // Logging again replaces it.
    await h.ok(log(h.femi, { ...body, labourMinutes: 120 }));
    const task = await h.ok<Task>(h.femi.get(`/tasks/${job.id}`));
    expect(task.workOrder).toMatchObject({ labourMinutes: 120, costMinor: '3550000' });
    expect(await db.auditEvent.count({ where: { action: 'work_order.logged' } })).toBe(2);

    // Resolved with the after photo (task engine), then verified: no more changes.
    await h.ok(h.femi.send(`/tasks/${job.id}/resolve`, { note: 'Replaced capacitor, regassed' }));
    await h.ok(h.gm.send(`/tasks/${job.id}/verify`, {}));
    expect(errorOf(await log(h.gm, body)).code).toBe('STATE_TRANSITION_INVALID');
    expect((await h.ok<Task>(h.gm.get(`/tasks/${job.id}`))).canLogWork).toBe(false);

    const history = await h.ok<Asset>(h.femi.get(`/assets/${ac.id}`));
    expect(history.history).toEqual([
      expect.objectContaining({ status: 'VERIFIED', labourMinutes: 120, costMinor: '3550000' }),
    ]);
    expect(history.totals).toEqual({ jobs: 1, labourMinutes: 120, costMinor: '3550000' });
    const onAsset = await h.ok<{ data: Task[] }>(h.gm.get(`/tasks?assetId=${ac.id}`));
    expect(onAsset.data.map((t) => t.id)).toEqual([job.id]);
  });

  it('puts a job on an asset while working it; a retired asset takes no new jobs', async () => {
    const h = await hotel();
    const ac = await h.ok<Asset>(h.femi.send('/assets', AC));
    const job = await h.ok<Task>(
      h.gm.send('/tasks', {
        templateId: h.faultTemplateId,
        roomId: h.r101.id,
        assigneeId: h.femiId,
      }),
    );
    expect(job.asset).toBeNull();
    await h.ok(
      h.femi.send(`/work-orders/${job.id}/detail`, {
        parts: [],
        labourMinutes: 30,
        vendorName: null,
        vendorCostMinor: '0',
        assetId: ac.id,
      }),
    );
    expect((await h.ok<Asset>(h.femi.get(`/assets/${ac.id}`))).openJobs).toBe(1);

    // Not retired while a job is open.
    expect(errorOf(await h.femi.patch(`/assets/${ac.id}`, { status: 'RETIRED' })).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    await h.ok(h.femi.send(`/tasks/${job.id}/acknowledge`));
    await h.ok(h.femi.send(`/tasks/${job.id}/start`));
    await h.ok(h.femi.send(`/tasks/${job.id}/resolve`, { note: 'Filter cleaned' }));
    await h.ok(h.gm.send(`/tasks/${job.id}/verify`, {}));
    await h.ok(h.femi.patch(`/assets/${ac.id}`, { status: 'RETIRED' }));
    expect(
      errorOf(await h.gm.send('/tasks', { templateId: h.faultTemplateId, assetId: ac.id })).code,
    ).toBe('VALIDATION_ERROR');
  });
});
