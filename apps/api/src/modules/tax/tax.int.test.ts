import { calculateTaxes, TAX_FIXTURES, versionsOn, type DatedTaxVersion } from '@hotel/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { expectViolation, resetDb, SQLSTATE, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { hotelClient, makeHotel } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { createDefaultTaxes, EXAMPLE_TAXES } from './defaults.ts';

// Revenue codes, tax rules and dated versions (PRD M4-17, M4 rules 1–2; T-032), with the
// Lagos example taxes new Nigerian properties start with.

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const TODAY = '2026-11-10';

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

async function hotel() {
  const h = await makeHotel(db, now);
  await createDefaultTaxes(db, { id: h.p1.id, country: 'NG', settings: {} }, TODAY);
  const c = hotelClient(db, clock, h.p1.id);
  const as = async (userId: string) => c.as(await sessionCookie(db, userId, clock));
  const codes = await db.revenueCode.findMany({ where: { propertyId: h.p1.id } });
  const code = (c: string) => codes.find((x) => x.code === c)?.id ?? '';
  const rules = await db.taxRule.findMany({ where: { propertyId: h.p1.id } });
  const rule = (name: string) => rules.find((r) => r.name === name)?.id ?? '';
  return { ...h, c, as, gmc: await as(h.gm.id), code, rule };
}

type Rule = {
  id: string;
  name: string;
  currentVersionId: string | null;
  versions: (DatedTaxVersion & { id: string })[];
};
const issuesOf = (res: { body: unknown }) =>
  (errorOf(res).details?.['issues'] as { path: string }[]).map((i) => i.path);
const audit = (action: string) =>
  db.auditEvent.findMany({ where: { action }, orderBy: { id: 'asc' } });

describe('Lagos example taxes for new properties', () => {
  it('creates service charge, VAT and consumption tax that reproduce the worked example', async () => {
    const h = await hotel();
    const res = await h.gmc.get('/tax-rules');
    expect(res.status).toBe(200);
    const { data, confirmation } = res.body as { data: Rule[]; confirmation: object };
    expect(confirmation).toEqual({ examples: true, confirmedAt: null, confirmedBy: null });
    expect(
      data.map((r) => [
        r.name,
        r.versions[0]?.rateBps,
        r.versions[0]?.basis,
        r.versions[0]?.sequence,
      ]),
    ).toEqual([
      ['Lagos consumption tax', 500, 'NET', 3],
      ['Service charge', 1000, 'NET', 1],
      ['VAT', 750, 'NET_PLUS_PRIOR', 2],
    ]);

    // Room revenue carries all three; posting ₦100,000 gives the fixture's ₦123,250.
    const codes = (await h.gmc.get('/revenue-codes')).body as {
      data: { code: string; taxRuleIds: string[] }[];
    };
    expect(codes.data.map((c) => c.code)).toEqual(['FNB', 'LCT', 'MISC', 'ROOM', 'SVC', 'VAT']);
    const room = codes.data.find((c) => c.code === 'ROOM');
    const versions = data
      .filter((r) => room?.taxRuleIds.includes(r.id))
      .flatMap((r) => r.versions.map((v) => ({ ...v, taxRuleId: r.name })));
    const fixture = TAX_FIXTURES[0];
    const result = calculateTaxes(10_000_000n, versionsOn(versions, TODAY));
    expect(Object.fromEntries(result.taxes.map((t) => [t.taxRuleId, t.amountMinor]))).toEqual({
      'Service charge': fixture?.taxes['SVC'],
      VAT: fixture?.taxes['VAT'],
      'Lagos consumption tax': fixture?.taxes['LCT'],
    });
    expect(result.totalMinor).toBe(12_325_000n);
  });

  it('gives other countries revenue codes without taxes, and never runs twice', async () => {
    const h = await makeHotel(db, now);
    await createDefaultTaxes(db, { id: h.p2.id, country: 'GH', settings: {} }, TODAY);
    const codes = await db.revenueCode.findMany({ where: { propertyId: h.p2.id } });
    expect(codes.map((c) => c.code).sort()).toEqual(['FNB', 'MISC', 'ROOM']);
    expect(codes.every((c) => c.taxRuleIds.length === 0)).toBe(true);
    expect(await db.taxRule.count({ where: { propertyId: h.p2.id } })).toBe(0);

    await createDefaultTaxes(db, { id: h.p1.id, country: 'NG', settings: {} }, TODAY);
    await createDefaultTaxes(db, { id: h.p1.id, country: 'NG', settings: {} }, TODAY);
    expect(await db.taxRule.count({ where: { propertyId: h.p1.id } })).toBe(EXAMPLE_TAXES.length);
  });

  it('keeps the setup tax step open until someone confirms the rates', async () => {
    const h = await hotel();
    const taxStep = async () =>
      (
        (await h.gmc.get(`/properties/${h.p1.id}`)).body as {
          checklist: { steps: { id: string; status: string }[] };
        }
      ).checklist.steps.find((s) => s.id === 'tax')?.status;
    expect(await taxStep()).toBe('TODO');

    const res = await h.gmc.post('/tax-rules/confirm');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      examples: true,
      confirmedAt: '2026-11-10T09:00:00Z',
      confirmedBy: { id: h.gm.id, name: h.gm.name },
    });
    expect(await taxStep()).toBe('DONE');
    const [event] = await audit('tax.confirmed');
    expect(event).toMatchObject({ actorUserId: h.gm.id, after: { examples: true } });
  });
});

describe('tax rule versions (M4 rule 1)', () => {
  it('starts a new rate from a date and closes the version in force, leaving it unchanged', async () => {
    const h = await hotel();
    const vat = h.rule('VAT');
    const res = await h.gmc.post(`/tax-rules/${vat}/versions`, {
      effectiveFrom: '2027-01-01',
      rateBps: 1000,
      basis: 'NET_PLUS_PRIOR',
      sequence: 2,
    });
    expect(res.status).toBe(201);
    const rule = res.body as Rule;
    expect(rule.versions.map((v) => [v.effectiveFrom, v.effectiveTo, v.rateBps])).toEqual([
      [TODAY, '2027-01-01', 750],
      ['2027-01-01', null, 1000],
    ]);
    // Today still uses 7.5%.
    expect(rule.currentVersionId).toBe(rule.versions[0]?.id);
    const [event] = await audit('taxrule.version_added');
    expect(event).toMatchObject({
      entityId: vat,
      before: { rateBps: 750 },
      after: { rateBps: 1000, effectiveFrom: '2027-01-01' },
    });
  });

  it('refuses past dates and dates not after the latest version', async () => {
    const h = await hotel();
    const add = (effectiveFrom: string) =>
      h.gmc.post(`/tax-rules/${h.rule('VAT')}/versions`, {
        effectiveFrom,
        rateBps: 1000,
        sequence: 2,
      });
    expect(issuesOf(await add('2026-11-09'))).toEqual(['body.effectiveFrom']);
    expect(issuesOf(await add(TODAY))).toEqual(['body.effectiveFrom']); // same day as the current
    expect((await add('2026-12-01')).status).toBe(201);
    expect(issuesOf(await add('2026-11-20'))).toEqual(['body.effectiveFrom']);
  });

  it('never lets the database change or remove a version', async () => {
    const h = await hotel();
    const version = await db.taxRuleVersion.findFirstOrThrow({
      where: { taxRuleId: h.rule('VAT') },
    });
    await expect(
      db.taxRuleVersion.update({ where: { id: version.id }, data: { rateBps: 800 } }),
    ).rejects.toThrow(/append-only/);
    await expect(db.taxRuleVersion.delete({ where: { id: version.id } })).rejects.toThrow(
      /append-only/,
    );
  });

  it('adds a tax on a tax code only, starting today or later', async () => {
    const h = await hotel();
    const onIncome = await h.gmc.post('/tax-rules', {
      name: 'Tourism levy',
      authority: 'LSTB',
      revenueCodeId: h.code('ROOM'),
      version: { effectiveFrom: TODAY, rateBps: 100, sequence: 4 },
    });
    expect(issuesOf(onIncome)).toEqual(['body.revenueCodeId']);

    const code = await h.gmc.post('/revenue-codes', {
      code: 'LEVY',
      name: 'Tourism levy',
      group: 'TAX',
    });
    expect(code.status).toBe(201);
    const created = await h.gmc.post('/tax-rules', {
      name: 'Tourism levy',
      authority: 'LSTB',
      revenueCodeId: (code.body as { id: string }).id,
      version: { effectiveFrom: TODAY, rateBps: 100, sequence: 4 },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Tourism levy',
      versions: [{ effectiveFrom: TODAY, rateBps: 100, basis: 'NET', inclusive: false }],
    });
    expect((await audit('taxrule.created')).length).toBe(1);
  });
});

describe('revenue codes (M4-17)', () => {
  it('creates codes with taxes in their order; tax codes carry none', async () => {
    const h = await hotel();
    const laundry = await h.gmc.post('/revenue-codes', {
      code: 'laundry',
      name: 'Laundry',
      group: 'OTHER',
      taxRuleIds: [h.rule('VAT')],
    });
    expect(laundry.status).toBe(201);
    expect(laundry.body).toMatchObject({ code: 'LAUNDRY', taxRuleIds: [h.rule('VAT')] });
    expect(
      issuesOf(
        await h.gmc.post('/revenue-codes', {
          code: 'X',
          name: 'X',
          group: 'TAX',
          taxRuleIds: [h.rule('VAT')],
        }),
      ),
    ).toEqual(['body.code']); // X is too short a code
    expect(
      issuesOf(
        await h.gmc.post('/revenue-codes', {
          code: 'TAX2',
          name: 'Tax 2',
          group: 'TAX',
          taxRuleIds: [h.rule('VAT')],
        }),
      ),
    ).toEqual(['body.taxRuleIds']);
    expect(
      issuesOf(await h.gmc.post('/revenue-codes', { code: 'ROOM', name: 'Again', group: 'ROOM' })),
    ).toEqual(['body.code']);
    expect(
      issuesOf(
        await h.gmc.post('/revenue-codes', {
          code: 'SPA',
          name: 'Spa',
          group: 'OTHER',
          taxRuleIds: [crypto.randomUUID()],
        }),
      ),
    ).toEqual(['body.taxRuleIds']);
  });

  it('changes a code’s taxes and refuses to retire a code a tax posts to', async () => {
    const h = await hotel();
    const res = await h.gmc.patch(`/revenue-codes/${h.code('MISC')}`, {
      taxRuleIds: [h.rule('Service charge'), h.rule('VAT')],
    });
    expect(res.status).toBe(200);
    const [event] = await audit('revenuecode.updated');
    expect(event?.before).toEqual({ taxRuleIds: [h.rule('VAT')] });

    const retire = await h.gmc.patch(`/revenue-codes/${h.code('VAT')}`, { active: false });
    expect(retire.status).toBe(409);
    expect(errorOf(retire)).toMatchObject({
      code: 'STATE_TRANSITION_INVALID',
      details: { taxRules: 1 },
    });
  });

  it('lets everyone read codes and taxes; changes need tax.manage', async () => {
    const h = await hotel();
    const fd = await h.as(h.fd.id);
    expect((await fd.get('/revenue-codes')).status).toBe(200);
    expect((await fd.get('/tax-rules')).status).toBe(200);
    const refused = await fd.post('/tax-rules/confirm');
    expect(refused.status).toBe(403);
    expect(errorOf(refused).details).toEqual({ permission: 'tax.manage' });
  });
});

describe('database guards', () => {
  it('keeps rates within 0–100% and one version in force per date', async () => {
    const h = await hotel();
    const vat = h.rule('VAT');
    const version = (from: string, to: string | null, rateBps = 750) =>
      db.taxRuleVersion.create({
        data: {
          taxRuleId: vat,
          effectiveFrom: new Date(from),
          effectiveTo: to ? new Date(to) : null,
          rateBps,
          sequence: 2,
        },
      });
    await expectViolation(
      version('2030-01-01', null, 10_001),
      SQLSTATE.CHECK,
      'tax_rule_versions_rate_check',
    );
    await expectViolation(
      version('2030-01-01', '2030-01-01'),
      SQLSTATE.CHECK,
      'tax_rule_versions_dates_check',
    );
    // The open version from today overlaps anything later.
    await expectViolation(
      version('2030-01-01', null),
      SQLSTATE.EXCLUSION,
      'tax_rule_versions_no_overlap',
    );
  });
});
