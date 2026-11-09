import { createHmac, randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../test/db.ts';
import { inHouse } from '../../../test/in-house.ts';
import { AiUnavailableError, type AiRequest } from '../../core/ai.ts';
import { FAKE_WHATSAPP_SECRET } from '../../core/messaging.ts';
import { createTenantDb } from '../../core/tenant-db.ts';
import { TEST_CONFIG } from '../../../test/helpers.ts';
import type { FileStore } from '../../core/files.ts';
import { runAssistant, type AssistantDeps } from './assistant.ts';

// The WhatsApp booking assistant (PRD M14-10; M14 AC: "the WhatsApp assistant never holds a room
// the availability and quote services would refuse"; T-117).

const db = testDb();
let now: Date;
const clock = () => new Date(now);
const logger = { info: () => undefined, warn: () => undefined } as unknown as Logger;

beforeEach(async () => {
  await resetDb(db);
  now = new Date('2026-11-10T09:00:00Z');
});

const PHONE = '+2348035550000';
const SETTINGS = {
  slug: 'demo-lagos',
  enabled: true,
  headline: null,
  description: 'Calm hotel by the marina.',
  policies: null,
  photoFileIds: [],
  allowPayFull: true,
  allowDeposit: true,
  depositBps: 3000,
  allowPayAtHotel: true,
  assistantEnabled: true,
  assistantNotes: 'Free parking.',
};
const STAY = { arrival: '2026-11-20', departure: '2026-11-22', adults: 1, children: 0 };

async function hotel(settings: object = {}) {
  const h = await inHouse(db, clock);
  const type = await db.roomType.findFirstOrThrow({ where: { propertyId: h.p1.id } });
  const bar = await db.ratePlan.findFirstOrThrow({ where: { propertyId: h.p1.id, code: 'BAR' } });
  await db.ratePlan.update({ where: { id: bar.id }, data: { isPublic: true } });
  await h.ok(h.gm.put('/booking-engine/settings', { ...SETTINGS, ...settings }));
  const say = (text: string, from = PHONE) => {
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  { id: randomUUID(), from: from.slice(1), type: 'text', text: { body: text } },
                ],
              },
            },
          ],
        },
      ],
    });
    const signature = createHmac('sha256', FAKE_WHATSAPP_SECRET).update(body).digest('hex');
    return request(h.app)
      .post('/api/v1/webhooks/whatsapp/fake')
      .set('Content-Type', 'application/json')
      .set('x-hub-signature-256', `sha256=${signature}`)
      .send(body);
  };
  const deps: AssistantDeps = {
    db,
    tenantDb: createTenantDb(db),
    clock,
    config: TEST_CONFIG,
    provider: h.payments,
    email: h.email,
    store: {} as FileStore,
    ai: h.ai,
    messages: h.messages,
    logger,
  };
  const thread = () => db.messageThread.findFirstOrThrow({ where: { phone: PHONE } });
  const run = async () => runAssistant(deps, (await thread()).id);
  return { ...h, type, bar, say, deps, thread, run };
}

/** Plays the model: calls these tools in turn, then says `reply`. */
const script =
  (calls: [string, object][], reply: string, seen: string[] = []) =>
  async (req: AiRequest) => {
    for (const [name, input] of calls) {
      try {
        seen.push(`${name}:${(await req.runTool?.(name, input)) ?? ''}`);
      } catch (err) {
        seen.push(`${name}!${(err as Error).message}`);
      }
    }
    return reply;
  };

describe('answering (M14-10)', () => {
  it('reaches a new guest through the hotel’s code, answers from its facts', async () => {
    const h = await hotel();
    h.ai.respond = script([], 'Yes, parking is free.');
    await h.say('Do you have parking? #demo-lagos');
    await h.run();
    expect(h.messages.sentTexts).toMatchObject([{ to: PHONE, body: 'Yes, parking is free.' }]);
    const user = h.ai.requests[0]?.user ?? '';
    expect(user).toContain('Calm hotel by the marina.');
    expect(user).toContain('Free parking.');
    expect(user).toContain('Guest: Do you have parking?');
    const stored = await db.message.findFirstOrThrow({ where: { direction: 'OUT' } });
    expect(stored).toMatchObject({ kind: 'ASSISTANT', status: 'SENT' });
    expect(await db.usageCounter.findFirstOrThrow()).toMatchObject({
      metric: 'AI_ASSISTANT',
      count: 1,
    });
  });

  it('stays quiet when switched off, and replies once per message', async () => {
    const h = await hotel({ assistantEnabled: false });
    await h.say('Hello #demo-lagos');
    await h.run();
    expect(h.ai.requests).toEqual([]);

    await h.ok(h.gm.put('/booking-engine/settings', SETTINGS));
    h.ai.respond = script([], 'Hello!');
    await h.run();
    await h.run(); // The event delivered twice.
    expect(h.messages.sentTexts).toHaveLength(1);
  });

  it('tells a phone with no hotel how to reach one, without calling the AI', async () => {
    const h = await hotel();
    await h.say('Hello?', '+2348099990000');
    expect(h.messages.sentTexts[0]?.body).toContain('booking page');
    expect(await db.messageThread.count()).toBe(0);
  });
});

describe('quoting and holding (M14-10)', () => {
  it('quotes through the booking page’s own availability', async () => {
    const h = await hotel();
    const seen: string[] = [];
    h.ai.respond = script([['check_availability', STAY]], 'We have a room.', seen);
    await h.say('A room please #demo-lagos');
    await h.run();
    expect(seen[0]).toContain(h.type.id);
    expect(seen[0]).toContain(h.bar.id);
    expect(seen[0]).toContain('total_with_tax');
  });

  it('holds a room with a payment link, source WhatsApp, and sends the link', async () => {
    const h = await hotel();
    const hold = {
      ...STAY,
      room_type_id: h.type.id,
      rate_plan_id: h.bar.id,
      first_name: 'Musa',
      last_name: 'Bello',
      email: 'musa@guest.test',
    };
    h.ai.respond = script([['create_hold', hold]], 'Held for you for 30 minutes.');
    await h.say('Yes please book it #demo-lagos');
    await h.run();
    const r = await db.reservation.findFirstOrThrow({ where: { source: 'WHATSAPP' } });
    expect(r.status).toBe('TENTATIVE');
    const intent = await db.paymentIntent.findFirstOrThrow({ where: { reservationId: r.id } });
    expect(h.messages.sentTexts[0]?.body).toContain(intent.checkoutUrl);
    const inv = await db.roomTypeInventory.findFirstOrThrow({
      where: { roomTypeId: h.type.id, date: new Date('2026-11-20T00:00:00Z') },
    });
    expect(inv.held).toBe(1);
  });

  it('never holds what the services would refuse', async () => {
    const h = await hotel();
    await db.ratePlan.update({ where: { id: h.bar.id }, data: { isPublic: false } });
    const seen: string[] = [];
    const hold = {
      ...STAY,
      room_type_id: h.type.id,
      rate_plan_id: h.bar.id,
      first_name: 'Musa',
      last_name: 'Bello',
      email: 'musa@guest.test',
    };
    h.ai.respond = script([['create_hold', hold]], 'Sorry, I can’t do that.', seen);
    await h.say('Book the hidden rate #demo-lagos');
    await h.run();
    expect(seen[0]).toContain('create_hold!');
    expect(await db.reservation.count({ where: { source: 'WHATSAPP' } })).toBe(0);

    // Bad details from the model never reach the booking.
    await db.ratePlan.update({ where: { id: h.bar.id }, data: { isPublic: true } });
    h.ai.respond = script(
      [['create_hold', { ...hold, email: 'not-an-email' }]],
      'Your email?',
      seen,
    );
    await h.say('Book it');
    await h.run();
    expect(await db.reservation.count({ where: { source: 'WHATSAPP' } })).toBe(0);
  });

  it('has no way to do anything else', async () => {
    const h = await hotel();
    const seen: string[] = [];
    h.ai.respond = script([['cancel_reservation', { id: 'x' }]], 'No.', seen);
    await h.say('Cancel everything #demo-lagos');
    await h.run();
    expect(seen[0]).toBe('cancel_reservation!No such tool');
    expect((h.ai.requests[0]?.tools ?? []).map((t) => t.name).sort()).toEqual([
      'check_availability',
      'create_hold',
      'hand_over_to_staff',
    ]);
  });
});

describe('handing over (M14-10)', () => {
  it('when asked: flags it for staff and stays quiet', async () => {
    const h = await hotel();
    h.ai.respond = script(
      [['hand_over_to_staff', { reason: 'Wants a manager' }]],
      'Someone will reply.',
    );
    await h.say('I want a manager #demo-lagos');
    await h.run();
    const t = await h.thread();
    expect(t.needsStaff).toBe(true);
    expect(t.assistantPausedUntil).not.toBeNull();

    await h.say('Hello?');
    await h.run();
    expect(h.messages.sentTexts).toHaveLength(1);
  });

  it('when the AI is unavailable the guest is told and staff are flagged', async () => {
    const h = await hotel();
    h.ai.respond = () => Promise.reject(new AiUnavailableError('down'));
    await h.say('Hello #demo-lagos');
    await h.run();
    expect(h.messages.sentTexts[0]?.body).toContain('member of our team');
    expect((await h.thread()).needsStaff).toBe(true);
  });

  it('staff replying takes over; handing back wakes the assistant', async () => {
    const h = await hotel();
    h.ai.respond = script([], 'Hello!');
    await h.say('Hi #demo-lagos');
    await h.run();
    const t = await h.thread();
    expect(
      (await h.fd.send(`/message-threads/${t.id}/messages`, { body: 'Mary here' })).status,
    ).toBe(201);
    await h.say('Thanks Mary');
    await h.run();
    expect(h.messages.sentTexts).toHaveLength(2); // The assistant's first, then Mary's.

    const back = await h.fd.post(`/message-threads/${t.id}/assistant`, { active: true });
    expect(back.body).toMatchObject({ assistantPaused: false, needsStaff: false });
    await h.run();
    expect(h.messages.sentTexts).toHaveLength(3);
  });
});
