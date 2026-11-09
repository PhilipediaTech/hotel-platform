import type { Logger } from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf } from '../../../test/helpers.ts';
import { inHouse } from '../../../test/in-house.ts';
import { AiUnavailableError, createFakeAiProvider, createOffProvider } from '../../core/ai.ts';
import { sendMorningSummaries, usesOnlyTheFacts } from './ai.ts';

// The owner's AI features (PRD M14-11, M14-12, M14 rules: "AI features answer only from the
// hotel's own data and never change data"; "AI use is counted per hotel"; T-116).

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-11T06:10:00Z'); // 07:10 in Lagos
});

const FLASH = {
  roomsAvailable: 10,
  roomsSold: 7,
  occupancyBps: 7000,
  roomRevenueMinor: '31500000',
  adrMinor: '4500000',
  revparMinor: '3150000',
  paymentsByMethod: [{ method: 'CASH', amountMinor: '20000000' }],
};

async function hotel() {
  const start = new Date(now);
  now = new Date('2026-11-10T09:00:00Z');
  const h = await inHouse(db, clock);
  now = start;
  await db.user.update({ where: { id: h.owner.id }, data: { phone: '+2348030000001' } });
  await db.nightAuditRun.create({
    data: {
      propertyId: h.p1.id,
      businessDate: new Date('2026-11-10T00:00:00Z'),
      status: 'COMPLETED',
      finishedAt: now,
      startedById: h.owner.id,
      summary: { reports: { flash: FLASH } },
    } as never,
  });
  const summaries = () =>
    db.notificationDelivery.findMany({ where: { templateCode: 'OWNER_SUMMARY' } });
  const usage = () => db.usageCounter.findMany({ where: { organisationId: h.org.id } });
  const manager = async () => h.as((await h.person('gm', h.p1.id)).id);
  return { ...h, summaries, usage, manager };
}

const summaryOf = (d: { payload: unknown }) =>
  (d.payload as { vars: { summary: string } }).vars.summary;

describe('the morning summary (M14-11)', () => {
  it('goes to the owner at 07:00, once, from the night’s figures', async () => {
    const h = await hotel();
    const ai = createFakeAiProvider();
    ai.respond = () => 'A good night: Occupancy 70% and room revenue ₦315,000.00.';
    expect(await sendMorningSummaries(db, ai, clock, logger)).toBe(1);
    const [sent] = (await h.summaries()).filter((d) => d.channel === 'WHATSAPP');
    expect(sent).toMatchObject({ recipient: '+2348030000001', channel: 'WHATSAPP' });
    expect(summaryOf(sent as { payload: unknown })).toContain('A good night');
    expect(ai.requests[0]?.user).toContain('Occupancy 70%');
    expect(ai.requests[0]?.user).toContain('7 of 10 rooms sold');

    expect(await sendMorningSummaries(db, ai, clock, logger)).toBe(0);
    expect(ai.requests).toHaveLength(1);
    expect((await h.usage())[0]).toMatchObject({ metric: 'AI_SUMMARY', count: 1 });
  });

  it('also goes by email to owners and to those who get the flash report', async () => {
    const h = await hotel();
    await sendMorningSummaries(db, createFakeAiProvider(), clock, logger);
    const email = (await h.summaries()).filter((d) => d.channel === 'EMAIL');
    const gm = await db.user.findUniqueOrThrow({ where: { id: h.gmId } });
    expect(email.map((d) => d.recipient)).toEqual(
      expect.arrayContaining([gm.email, h.owner.email]),
    );
    const fd = await db.user.findUniqueOrThrow({ where: { id: h.fdId } });
    expect(email.map((d) => d.recipient)).not.toContain(fd.email);
    expect(new Set(email.map((d) => d.recipient)).size).toBe(email.length);
    // Nobody is sent it twice on the next run.
    await sendMorningSummaries(db, createFakeAiProvider(), clock, logger);
    expect((await h.summaries()).filter((d) => d.channel === 'EMAIL')).toHaveLength(email.length);
  });

  it('waits for 07:00 at the hotel', async () => {
    await hotel();
    now = new Date('2026-11-11T05:50:00Z'); // 06:50 in Lagos
    const ai = createFakeAiProvider();
    expect(await sendMorningSummaries(db, ai, clock, logger)).toBe(0);
  });

  it('a figure the model made up is thrown out and the plain figures go instead', async () => {
    const h = await hotel();
    const ai = createFakeAiProvider();
    ai.respond = () => 'Superb night with 95% occupancy.';
    await sendMorningSummaries(db, ai, clock, logger);
    const [sent] = await h.summaries();
    const text = summaryOf(sent as { payload: unknown });
    expect(text).toMatch(/^Occupancy 70%, 7 of 10 rooms sold, room revenue .*315,000.00/);
    expect(text).not.toContain('95%');
  });

  it('if the model is unavailable the plain figures still go', async () => {
    const h = await hotel();
    const ai = createFakeAiProvider();
    ai.respond = () => Promise.reject(new AiUnavailableError('down'));
    expect(await sendMorningSummaries(db, ai, clock, logger)).toBe(1);
    expect(summaryOf((await h.summaries())[0] as { payload: unknown })).toContain('Occupancy 70%');
  });

  it('with AI off nothing is sent, and old figures are not news', async () => {
    const h = await hotel();
    expect(await sendMorningSummaries(db, createOffProvider(), clock, logger)).toBe(0);
    now = new Date('2026-11-15T06:10:00Z');
    expect(await sendMorningSummaries(db, createFakeAiProvider(), clock, logger)).toBe(0);
    expect(await h.summaries()).toEqual([]);
  });

  it('checks numbers, allowing thousands commas and a closing full stop', () => {
    const facts = 'Occupancy 70%, revenue ₦315,000.00, 7 of 10 rooms';
    expect(usesOnlyTheFacts('Occupancy was 70% with ₦315,000.00 and 7 rooms.', facts)).toBe(true);
    expect(usesOnlyTheFacts('Occupancy was 71%.', facts)).toBe(false);
    expect(usesOnlyTheFacts('About ₦315,000 earned.', facts)).toBe(false);
  });
});

describe('questions about the figures (M14-12)', () => {
  it('answers from a report and names it', async () => {
    const h = await hotel();
    h.ai.respond = async (request) => {
      await request.runTool?.('get_flash_report', { date: '2026-11-10' });
      return 'Occupancy was 70% on 10 November, from the flash report.';
    };
    const res = await h.ok<{ answer: string; sources: unknown[]; grounded: boolean }>(
      (await h.manager()).post('/reports/ask', { question: 'How was occupancy last night?' }),
    );
    expect(res).toMatchObject({
      answer: expect.stringContaining('70%') as string,
      grounded: true,
      sources: [{ report: 'Flash report', detail: '2026-11-10' }],
    });
    expect((await h.usage())[0]).toMatchObject({ metric: 'AI_QUESTION', count: 1 });
  });

  it('with no report used, says the answer is not grounded', async () => {
    const h = await hotel();
    h.ai.respond = () => 'I can only answer from your reports.';
    const res = await h.ok<{ grounded: boolean; sources: unknown[] }>(
      (await h.manager()).post('/reports/ask', { question: 'What is the capital of France?' }),
    );
    expect(res).toMatchObject({ grounded: false, sources: [] });
  });

  it('offers only the reports the person may open; a report it can’t run is an error', async () => {
    const h = await hotel();
    let toolNames: string[] = [];
    let refused = '';
    h.ai.respond = async (request) => {
      toolNames = (request.tools ?? []).map((t) => t.name);
      await request.runTool?.('get_tax_report', { from: 'x', to: 'y' }).catch((e: Error) => {
        refused = e.message;
      });
      return 'Done';
    };
    const role = await db.role.findFirstOrThrow({
      where: { organisationId: h.org.id, name: { contains: 'Front' } },
    });
    await db.role.update({ where: { id: role.id }, data: { permissions: ['report.dashboard'] } });
    await h.ok((await h.as(h.fdId)).post('/reports/ask', { question: 'How is business?' }));
    expect(toolNames).toEqual(['get_dashboard']);
    expect(refused).toBe('That report is not available');
  });

  it('needs the permission; when AI is unavailable it says so', async () => {
    const h = await hotel();
    const hk = await h.person('hk-attendant', h.p1.id);
    expect(
      (await (await h.as(hk.id)).post('/reports/ask', { question: 'How is business?' })).status,
    ).toBe(403);
    h.ai.respond = () => Promise.reject(new AiUnavailableError('down'));
    const res = await (await h.manager()).post('/reports/ask', { question: 'How is business?' });
    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe('AI_UNAVAILABLE');
  });
});
