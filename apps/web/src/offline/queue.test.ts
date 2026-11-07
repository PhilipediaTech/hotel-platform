import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, OfflineError, setApiPropertyId } from '../lib/api.ts';
import { discard, loadQueue, QUEUEABLE, replay, sendOrQueue } from './queue.ts';
import { clearSnapshots, isNetworkError, withSnapshot } from './snapshots.ts';
import { memoryStore, offlineStore, resetOfflineStore } from './store.ts';

// Offline queue and saved lists (spec tab 2 "Offline"; PRD NFR "Offline"; T-093).

const LAGOS = '0d0d0d0d-0000-4000-8000-000000000002';
const ABUJA = '0d0d0d0d-0000-4000-8000-000000000003';
const TASK = '44444444-0000-4000-8000-000000000001';
const who = { userId: 'user-1', propertyId: LAGOS };

let online = true;
type Call = { key: string; headers: Headers; body: unknown };
const calls: Call[] = [];
let answer: (call: Call) => Response | Promise<Response>;

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const apiError = (status: number, code: string, message: string) =>
  json(status, { error: { code, message, requestId: 'req_1' } });

beforeEach(async () => {
  online = true;
  calls.length = 0;
  answer = () => json(201, { id: TASK });
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  resetOfflineStore(memoryStore());
  await loadQueue();
  setApiPropertyId(LAGOS);
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init: RequestInit) => {
      const url = new URL(input, 'http://app.test');
      const call = {
        key: `${init.method} ${url.pathname.replace('/api/v1', '')}`,
        headers: new Headers(init.headers),
        body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      };
      calls.push(call);
      if (!online) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve(answer(call));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  setApiPropertyId(null);
});

const comment = (note: string) =>
  sendOrQueue(
    who,
    'addTaskComment',
    { params: { taskId: TASK }, body: { note } },
    { label: `Task 7: ${note}` },
  );

describe('sending or queueing (whitelisted actions only)', () => {
  it('online: sends at once with the action’s UUID as idempotency key', async () => {
    const sent = await comment('Guest asked for towels');
    expect(sent).toEqual({ queued: false, result: { id: TASK } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect((await (await offlineStore()).listActions()).length).toBe(0);
  });

  it('offline: keeps it on the device; on reconnect replays in order with the same keys', async () => {
    online = false;
    expect(await comment('First')).toEqual({ queued: true });
    expect(await comment('Second')).toEqual({ queued: true });
    expect(calls).toHaveLength(0);
    const waiting = await (await offlineStore()).listActions();
    expect(waiting.map((a) => [a.label, a.status])).toEqual([
      ['Task 7: First', 'pending'],
      ['Task 7: Second', 'pending'],
    ]);

    online = true;
    // The person meanwhile switched to another property: each action keeps its own.
    setApiPropertyId(ABUJA);
    expect(await replay(who)).toBe(2);
    expect(calls.map((c) => (c.body as { note: string }).note)).toEqual(['First', 'Second']);
    expect(calls.map((c) => c.headers.get('Idempotency-Key'))).toEqual(waiting.map((a) => a.id));
    expect(calls.every((c) => c.headers.get('X-Property-Id') === LAGOS)).toBe(true);
    expect(await (await offlineStore()).listActions()).toEqual([]);
  });

  it('a request that never reached the server is queued too', async () => {
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await comment('Lost')).toEqual({ queued: true });
  });

  it('a refusal on replay becomes a conflict to show; the next action still goes; discard', async () => {
    online = false;
    await comment('Too late');
    await comment('Fine');
    online = true;
    let n = 0;
    answer = () =>
      n++ === 0
        ? apiError(409, 'STATE_TRANSITION_INVALID', 'The task is closed.')
        : json(201, { id: TASK });
    expect(await replay(who)).toBe(1);
    const [left] = await (await offlineStore()).listActions();
    expect(left).toMatchObject({ status: 'conflict', error: 'The task is closed.' });
    await discard(left?.id ?? '');
    expect(await (await offlineStore()).listActions()).toEqual([]);
  });

  it('a network failure stops the run and keeps the rest for later; others’ actions wait', async () => {
    online = false;
    await comment('One');
    await sendOrQueue(
      { userId: 'user-2', propertyId: LAGOS },
      'startTask',
      { params: { taskId: TASK } },
      { label: 'Someone else' },
    );
    online = true;
    answer = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await replay(who)).toBe(0);
    answer = () => json(201, { id: TASK });
    expect(await replay(who)).toBe(1);
    // user-2's action waits for user-2.
    expect((await (await offlineStore()).listActions()).map((a) => a.userId)).toEqual(['user-2']);
  });

  it('a note whose booking changed is still done when the change was that note', async () => {
    online = false;
    const RES = '33333333-0000-4000-8000-000000000001';
    await sendOrQueue(
      who,
      'updateReservation',
      { params: { reservationId: RES }, body: { notes: 'VIP' } },
      { label: 'Booking LAG-1: note', ifMatch: '"3"' },
    );
    online = true;
    answer = (c) =>
      c.key.startsWith('PATCH')
        ? apiError(409, 'VERSION_CONFLICT', 'Changed meanwhile.')
        : json(200, { notes: 'VIP' });
    expect(await replay(who)).toBe(1);
    expect(calls[0]?.headers.get('If-Match')).toBe('"3"');
  });

  it('money, check-in and the rest cannot wait: only the whitelist, and only notes on a booking', async () => {
    expect([...QUEUEABLE].sort()).toEqual([
      'acknowledgeTask',
      'addTaskComment',
      'holdTask',
      'resolveTask',
      'startTask',
      'submitStatusReport',
      'updateAssignment',
      'updateReservation',
    ]);
    await expect(sendOrQueue(who, 'capturePayment' as never, {}, { label: 'x' })).rejects.toThrow(
      'cannot wait offline',
    );
    await expect(
      sendOrQueue(
        who,
        'updateReservation',
        { params: {}, body: { notes: 'x', guarantee: 'NONE' } },
        { label: 'x' },
      ),
    ).rejects.toThrow('Only notes');
  });
});

describe('the API client offline', () => {
  it('refuses any change before sending it, with a clear error; reads still try', async () => {
    online = false;
    await expect(
      api.call('capturePayment', {
        body: { folioId: TASK, method: 'CASH', amountMinor: '100' },
      } as never),
    ).rejects.toBeInstanceOf(OfflineError);
    expect(calls).toHaveLength(0);
    await expect(api.call('getMe')).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(1);
  });
});

describe('saved lists', () => {
  it('saves what it fetched and answers the saved copy when the network is gone', async () => {
    const list = vi.fn(() => Promise.resolve({ data: ['Ada'] }));
    const fetchList = withSnapshot('user-1|LAGOS|arrivals', list);
    expect(await fetchList()).toEqual({ data: ['Ada'] });
    list.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await fetchList()).toEqual({ data: ['Ada'] });
    // A real error (not the network) is not hidden by an old copy.
    list.mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'No'));
    await expect(fetchList()).rejects.toBeInstanceOf(ApiError);
    // Sign-out forgets the copies.
    await clearSnapshots();
    list.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(fetchList()).rejects.toBeInstanceOf(TypeError);
  });

  it('knows a network failure from a refusal', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkError(new ApiError(500, 'INTERNAL', 'x'))).toBe(false);
  });
});
