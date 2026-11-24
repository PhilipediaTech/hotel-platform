import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ChannelError, channexSignatureOk, createChannexManager } from './channel-manager.ts';

// The Channex client (M11-07; T-151) against a stand-in fetch: no network.

const BASE = 'https://staging.channex.io/api/v1';

function withAnswers(...answers: (Response | Error)[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const a of answers) {
    if (a instanceof Error) fetch.mockRejectedValueOnce(a);
    else fetch.mockResolvedValueOnce(a);
  }
  const channex = createChannexManager({ apiKey: 'k'.repeat(64), baseUrl: BASE, fetch });
  return { fetch, channex };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const created = (id: string) => json(201, { data: { type: 'x', id, attributes: {} } });

const sent = (fetch: ReturnType<typeof vi.fn>, n = 0) => {
  const [url, init] = fetch.mock.calls[n] as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: JSON.parse(init.body as string) as unknown,
  };
};

describe('Channex client', () => {
  it('creates a property with the key header and the wrapped body Channex expects', async () => {
    const { fetch, channex } = withAnswers(created('prop-1'));
    await expect(
      channex.createProperty({
        title: 'Obi Lagos',
        currency: 'NGN',
        timezone: 'Africa/Lagos',
        propertyType: 'hotel',
        country: 'NG',
        city: 'Lagos',
      }),
    ).resolves.toEqual({ id: 'prop-1' });
    expect(sent(fetch)).toEqual({
      url: `${BASE}/properties`,
      method: 'POST',
      headers: {
        'user-api-key': 'k'.repeat(64),
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: {
        property: {
          title: 'Obi Lagos',
          currency: 'NGN',
          timezone: 'Africa/Lagos',
          property_type: 'hotel',
          country: 'NG',
          city: 'Lagos',
        },
      },
    });
  });

  it('creates room types and per-room rate plans at the room type’s occupancy', async () => {
    const { fetch, channex } = withAnswers(created('rt-1'), created('rp-1'));
    await channex.createRoomType({
      propertyId: 'prop-1',
      title: 'Standard',
      countOfRooms: 12,
      occAdults: 2,
      defaultOccupancy: 2,
    });
    await channex.createRatePlan({
      propertyId: 'prop-1',
      roomTypeId: 'rt-1',
      title: 'Best available · Standard',
      currency: 'NGN',
      occupancy: 2,
      mealType: 'breakfast',
    });
    expect(sent(fetch, 0)).toMatchObject({
      url: `${BASE}/room_types`,
      body: {
        room_type: {
          property_id: 'prop-1',
          title: 'Standard',
          count_of_rooms: 12,
          occ_adults: 2,
          occ_children: 0,
          occ_infants: 0,
          default_occupancy: 2,
        },
      },
    });
    expect(sent(fetch, 1)).toMatchObject({
      url: `${BASE}/rate_plans`,
      body: {
        rate_plan: {
          property_id: 'prop-1',
          room_type_id: 'rt-1',
          sell_mode: 'per_room',
          rate_mode: 'manual',
          meal_type: 'breakfast',
          options: [{ occupancy: 2, is_primary: true }],
        },
      },
    });
  });

  it('turns Channex errors into ChannelErrors: validation, rate limit, no answer', async () => {
    const { channex } = withAnswers(
      json(422, {
        errors: {
          code: 'validation_error',
          title: 'Validation Error',
          details: { title: ['has already been taken'] },
        },
      }),
      json(
        429,
        { errors: { code: 'http_too_many_requests', title: 'Too Many Requests' } },
        {
          'Retry-After': '42',
        },
      ),
      new TypeError('fetch failed'),
    );
    const input = {
      propertyId: 'p',
      title: 'Standard',
      countOfRooms: 1,
      occAdults: 2,
      defaultOccupancy: 2,
    };
    const validation = await channex.createRoomType(input).catch((e: unknown) => e);
    expect(validation).toBeInstanceOf(ChannelError);
    expect(validation).toMatchObject({
      message: 'Channex answered 422: Validation Error',
      status: 422,
      details: { title: ['has already been taken'] },
      retryable: false,
    });
    expect(await channex.createRoomType(input).catch((e: unknown) => e)).toMatchObject({
      status: 429,
      retryAfterSeconds: 42,
      retryable: true,
    });
    expect(await channex.createRoomType(input).catch((e: unknown) => e)).toMatchObject({
      message: 'Channex could not be reached',
      status: null,
      retryable: true,
    });
  });

  it('never puts the key in an error message', async () => {
    const { channex } = withAnswers(
      json(401, { errors: { code: 'unauthorized', title: 'Unauthorized' } }),
    );
    const err = (await channex
      .createProperty({
        title: 'x',
        currency: 'NGN',
        timezone: 'Africa/Lagos',
        propertyType: 'hotel',
      })
      .catch((e: unknown) => e)) as ChannelError;
    expect(err.message).toBe('Channex answered 401: Unauthorized');
    expect(JSON.stringify(err)).not.toContain('kkkk');
  });

  it('sends availability and restrictions as Channex value lists, with task ID and warnings (T-152)', async () => {
    const task = (id: string, warnings?: unknown[]) =>
      json(200, {
        data: [{ id, type: 'task' }],
        meta: { message: 'Success', ...(warnings ? { warnings } : {}) },
      });
    const { fetch, channex } = withAnswers(
      task('task-1'),
      task('task-2', [{ date: '2026-11-10', warning: 'Rate is less than min rate' }]),
    );
    await expect(
      channex.updateAvailability([
        {
          propertyId: 'p',
          roomTypeId: 'rt',
          dateFrom: '2026-11-10',
          dateTo: '2026-11-12',
          availability: 3,
        },
      ]),
    ).resolves.toEqual({ taskId: 'task-1', warnings: [] });
    expect(sent(fetch, 0)).toMatchObject({
      url: `${BASE}/availability`,
      method: 'POST',
      body: {
        values: [
          {
            property_id: 'p',
            room_type_id: 'rt',
            date_from: '2026-11-10',
            date_to: '2026-11-12',
            availability: 3,
          },
        ],
      },
    });
    const restriction = {
      propertyId: 'p',
      ratePlanId: 'rp',
      dateFrom: '2026-11-10',
      dateTo: '2026-11-10',
      minStayArrival: 2,
      maxStay: 0,
      closedToArrival: true,
      closedToDeparture: false,
      stopSell: false,
    };
    await expect(
      channex.updateRestrictions([
        { ...restriction, rate: '12500.00' },
        { ...restriction, dateFrom: '2027-01-01', dateTo: '2027-01-05', stopSell: true },
      ]),
    ).resolves.toEqual({
      taskId: 'task-2',
      warnings: [{ date: '2026-11-10', warning: 'Rate is less than min rate' }],
    });
    const wire = {
      property_id: 'p',
      rate_plan_id: 'rp',
      date_from: '2026-11-10',
      date_to: '2026-11-10',
      min_stay_arrival: 2,
      max_stay: 0,
      closed_to_arrival: true,
      closed_to_departure: false,
      stop_sell: false,
    };
    // No price: the rate is left out, never sent as zero.
    expect(sent(fetch, 1)).toMatchObject({
      url: `${BASE}/restrictions`,
      body: {
        values: [
          { ...wire, rate: '12500.00' },
          { ...wire, date_from: '2027-01-01', date_to: '2027-01-05', stop_sell: true },
        ],
      },
    });
    expect((sent(fetch, 1).body as { values: object[] }).values[1]).not.toHaveProperty('rate');
  });

  it('reads the booking feed oldest first for one property, and acknowledges a revision (T-153)', async () => {
    const revision = {
      type: 'booking_revision',
      id: 'rev-1',
      attributes: { booking_id: 'bk-1', status: 'new' },
    };
    const { fetch, channex } = withAnswers(
      json(200, { meta: { total: 1, page: 1, limit: 10 }, data: [revision, { id: 7 }] }),
      json(200, { meta: { message: 'Success' } }),
    );
    await expect(channex.bookingFeed('prop 1')).resolves.toEqual([
      { id: 'rev-1', attributes: { booking_id: 'bk-1', status: 'new' } },
    ]);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${BASE}/booking_revisions/feed?filter[property_id]=prop%201&order[inserted_at]=asc`,
    );
    expect(init.method).toBe('GET');
    await channex.ackBookingRevision('rev-1');
    const [ackUrl, ackInit] = fetch.mock.calls[1] as [string, RequestInit];
    expect([ackUrl, ackInit.method, ackInit.body]).toEqual([
      `${BASE}/booking_revisions/rev-1/ack`,
      'POST',
      undefined,
    ]);
    // An answer without a list is not taken for an empty feed.
    const broken = withAnswers(json(200, { meta: {} }));
    await expect(broken.channex.bookingFeed('prop-1')).rejects.toBeInstanceOf(ChannelError);
  });
});

describe('Channex webhook signature (T-153)', () => {
  const secret = 'webhook-secret-for-tests-0001';
  const raw = Buffer.from('{"event":"booking","property_id":"p-1"}');
  const sign = (key: string, timestamp: string, body = raw) =>
    createHmac('sha256', key).update(`${timestamp}.`).update(body).digest('hex');
  const at = 1_800_000_000;
  const headers = (signature: string, timestamp = String(at)) => ({
    'x-hmac-timestamp': timestamp,
    'x-hmac-signature-256': signature,
  });

  it('takes HMAC-SHA256 of "<timestamp>.<raw body>", either signature while rotating', () => {
    expect(channexSignatureOk(raw, headers(sign(secret, String(at))), [secret], at)).toBe(true);
    // Two signatures (key rotation): one of ours is enough; two secrets of ours too.
    const both = `${sign('someone-elses-key-000000', String(at))},${sign(secret, String(at))}`;
    expect(channexSignatureOk(raw, headers(both), [secret], at)).toBe(true);
    expect(
      channexSignatureOk(
        raw,
        headers(sign(secret, String(at))),
        ['old-secret-0000000000', secret],
        at,
      ),
    ).toBe(true);
  });

  it('refuses a wrong key, a changed body, an old call, and missing headers', () => {
    expect(
      channexSignatureOk(raw, headers(sign('wrong-key-0000000000', String(at))), [secret], at),
    ).toBe(false);
    expect(
      channexSignatureOk(
        Buffer.from('{"event":"booking"}'),
        headers(sign(secret, String(at))),
        [secret],
        at,
      ),
    ).toBe(false);
    // More than 5 minutes off, either way.
    const old = String(at - 301);
    expect(channexSignatureOk(raw, headers(sign(secret, old), old), [secret], at)).toBe(false);
    expect(channexSignatureOk(raw, {}, [secret], at)).toBe(false);
    expect(channexSignatureOk(raw, headers('zz'), [secret], at)).toBe(false);
    // No secret set up: nothing passes.
    expect(channexSignatureOk(raw, headers(sign(secret, String(at))), [], at)).toBe(false);
  });
});
