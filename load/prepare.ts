import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { addDays, localDate } from '@hotel/shared';
import request from 'supertest';
import { createApp } from '../apps/api/src/app.ts';
import { createFakeAiProvider } from '../apps/api/src/core/ai.ts';
import { createSession } from '../apps/api/src/core/auth.ts';
import { systemClock } from '../apps/api/src/core/clock.ts';
import { loadConfig } from '../apps/api/src/core/config.ts';
import { createDb } from '../apps/api/src/core/db.ts';
import { createFakeEmailProvider } from '../apps/api/src/core/email.ts';
import { createLocalFileStore } from '../apps/api/src/core/files.ts';
import { createLogger } from '../apps/api/src/core/logger.ts';
import { createFakeMessageProvider } from '../apps/api/src/core/messaging.ts';
import { createFakePaymentProvider } from '../apps/api/src/core/payments.ts';
import { createDefaultApprovalPolicies } from '../apps/api/src/modules/approvals/defaults.ts';
import { ROLE_TEMPLATES } from '../apps/api/src/modules/identity/role-templates.ts';
import { createDefaultTaxes } from '../apps/api/src/modules/tax/defaults.ts';

// Load-test hotel (spec tab 8 "Load: k6 — availability p95, booking throughput, 80-room night
// audit time"; PRD NFR "Performance"; T-101). Builds, in the local database, a live hotel of 80
// rooms (4 types × 20) with rates for 90 days, 70 guests checked in tonight and 40 future
// bookings, through the real API (in-process). Writes load/.session.json (git-ignored) with
// sessions for the k6 scripts and the night-audit timer. Never runs against production.
//
//   npm run load:prepare
//
// Each run builds a new hotel group ("Load Test Hotels <time>"): run it again after a night
// audit, which closes the day.

const config = loadConfig(process.env);
if (config.nodeEnv === 'production') {
  console.error('Refusing to build a load-test hotel in production.');
  process.exit(1);
}
const db = createDb(config.databaseUrl);
const logger = createLogger({ ...config, logLevel: 'warn' });
const app = createApp({
  config,
  logger,
  db,
  email: createFakeEmailProvider(),
  payments: createFakePaymentProvider({ checkoutBase: `${config.appOrigin}/api/v1/dev/fake-pay` }),
  messages: createFakeMessageProvider(),
  ai: createFakeAiProvider(),
  files: createLocalFileStore({
    dir: config.localFilesDir,
    secret: config.sessionSecret,
    clock: systemClock,
  }),
});

const ROOM_TYPES = [
  { code: 'STD', name: 'Standard', amount: '3500000' },
  { code: 'DLX', name: 'Deluxe', amount: '5000000' },
  { code: 'EXE', name: 'Executive', amount: '7500000' },
  { code: 'STE', name: 'Suite', amount: '12000000' },
];
const ROOMS_PER_TYPE = 20;
const IN_HOUSE = 70;
const FUTURE = 40;
const DESK_STAFF = 12;

async function main() {
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const org = await db.organisation.create({
    data: { name: `Load Test Hotels ${stamp}`, country: 'NG' },
  });
  const property = await db.property.create({
    data: {
      organisationId: org.id,
      code: 'LOAD',
      name: 'Load Test Hotel',
      address: { line1: '1 Load Street', city: 'Lagos', state: 'Lagos', country: 'NG' },
      status: 'LIVE',
      settings: { paymentMethods: ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL'] },
    },
  });
  const today = localDate(new Date(), property.timeZone);

  const roles: Record<string, string> = {};
  for (const t of ROLE_TEMPLATES) {
    const role = await db.role.create({
      data: {
        organisationId: org.id,
        name: t.name,
        isSystem: true,
        requiresMfa: false,
        permissions: [...t.permissions],
      },
    });
    roles[t.slug] = role.id;
  }
  const suffix = randomUUID().slice(0, 6);
  const person = async (slug: string, n = 0) => {
    const tag = n ? `${slug}${n}` : slug;
    const user = await db.user.create({
      data: { email: `load-${tag}-${suffix}@load.test`, name: `Load ${tag}`, status: 'ACTIVE' },
    });
    await db.membership.create({
      data: {
        userId: user.id,
        organisationId: org.id,
        propertyId: property.id,
        roleId: roles[slug] ?? '',
      },
    });
    const { token } = await createSession(
      { db, config, clock: systemClock },
      { userId: user.id, sharedDevice: false, mfaPassed: true },
    );
    return `sid=${token}`;
  };
  const gm = await person('gm');
  const fd = await person('front-desk');
  const auditor = await person('night-auditor');
  // One signed-in clerk per k6 virtual user: the API allows 300 requests/min per user (spec
  // tab 4), so a single shared session would measure the rate limiter, not the desk.
  const desk: string[] = [];
  for (let i = 0; i < DESK_STAFF; i++) desk.push(await person('front-desk', i + 1));
  await createDefaultTaxes(db, { id: property.id, country: 'NG', settings: {} }, today);
  await createDefaultApprovalPolicies(db, org.id, property.id);

  const call = async <T>(
    cookie: string,
    method: 'get' | 'post' | 'put',
    path: string,
    body?: object,
    ifMatch?: string,
  ): Promise<T> => {
    let req = request(app)
      [method](`/api/v1${path}`)
      .set('Cookie', cookie)
      .set('X-Property-Id', property.id)
      .set('Origin', config.appOrigin)
      .set('Idempotency-Key', randomUUID());
    if (ifMatch) req = req.set('If-Match', ifMatch);
    const res = body ? await req.send(body) : await req;
    if (res.status >= 300) {
      throw new Error(`${method.toUpperCase()} ${path}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body as T;
  };

  console.log('Rooms and rates…');
  const types: { id: string; rooms: string[] }[] = [];
  for (const [i, t] of ROOM_TYPES.entries()) {
    const type = await call<{ id: string }>(gm, 'post', '/room-types', {
      code: t.code,
      name: t.name,
      maxOccupancy: 3,
    });
    const rooms: string[] = [];
    for (let n = 1; n <= ROOMS_PER_TYPE; n++) {
      const room = await call<{ id: string }>(gm, 'post', '/rooms', {
        number: `${i + 1}${String(n).padStart(2, '0')}`,
        roomTypeId: type.id,
      });
      rooms.push(room.id);
    }
    types.push({ id: type.id, rooms });
  }
  await db.room.updateMany({ where: { propertyId: property.id }, data: { hkStatus: 'CLEAN' } });
  const policy = await call<{ id: string }>(gm, 'post', '/cancellation-policies', {
    name: 'Flexible',
    rules: [{ daysBefore: 1, feeType: 'NIGHTS', value: 1 }],
    noShowFee: { feeType: 'NIGHTS', value: 1 },
  });
  const bar = await call<{ id: string }>(gm, 'post', '/rate-plans', {
    cancellationPolicyId: policy.id,
    code: 'BAR',
    name: 'Best available',
    kind: 'BAR',
  });
  for (const [i, t] of ROOM_TYPES.entries()) {
    await call(gm, 'put', '/rate-calendar', {
      ratePlanId: bar.id,
      roomTypeIds: [types[i]?.id],
      from: today,
      to: addDays(today, 90),
      set: { amountMinor: t.amount },
    });
  }

  const book = async (roomType: number, arrival: string, nights: number, name: string) => {
    const quote = await call<{ quoteId: string }>(fd, 'post', '/quotes', {
      roomTypeId: types[roomType]?.id,
      ratePlanId: bar.id,
      arrival,
      departure: addDays(arrival, nights),
      adults: 1,
    });
    return call<{ id: string; stays: { id: string; version: number }[] }>(
      fd,
      'post',
      '/reservations',
      {
        source: 'PHONE',
        booker: { firstName: name, lastName: 'Load' },
        stays: [{ quoteId: quote.quoteId }],
      },
    );
  };

  console.log(`${IN_HOUSE} guests checking in…`);
  for (let i = 0; i < IN_HOUSE; i++) {
    const type = i % ROOM_TYPES.length;
    const r = await book(type, today, 1 + (i % 4), `Guest${i}`);
    const stay = r.stays[0];
    const roomId = types[type]?.rooms[Math.floor(i / ROOM_TYPES.length)];
    if (!stay || !roomId) throw new Error('booking without a stay or room');
    await call(
      fd,
      'post',
      `/stays/${stay.id}/check-in`,
      {
        roomId,
        registration: {
          nationality: 'NG',
          purpose: 'BUSINESS',
          idType: 'PASSPORT',
          idNumber: `A${String(1_000_000 + i)}`,
        },
      },
      `"${stay.version}"`,
    );
  }

  console.log(`${FUTURE} future bookings…`);
  for (let i = 0; i < FUTURE; i++) {
    await book(i % ROOM_TYPES.length, addDays(today, 3 + (i % 25)), 1 + (i % 3), `Future${i}`);
  }

  const session = {
    apiBase: `http://localhost:${config.port}/api/v1`,
    origin: config.appOrigin,
    propertyId: property.id,
    businessDate: today,
    ratePlanId: bar.id,
    roomTypeIds: types.map((t) => t.id),
    cookies: { gm, frontDesk: fd, nightAuditor: auditor, desk },
  };
  writeFileSync(new URL('./.session.json', import.meta.url), JSON.stringify(session, null, 2));
  console.log(
    `Ready: ${org.name}, ${ROOM_TYPES.length * ROOMS_PER_TYPE} rooms, ${IN_HOUSE} in house, business date ${today}. Sessions in load/.session.json.`,
  );
}

try {
  await main();
} finally {
  await db.$disconnect();
}
