import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';

// Channel manager (PRD M11-07; tab 2: each provider behind an interface in core/ with a fake;
// T-151). Channex API v1: requests and responses are JSON, bodies wrapped by resource type
// ({"property": {...}}), answers {"data": {"id", "attributes"}}; errors {"errors": {"code",
// "title", "details"}}; 429 carries Retry-After. The key goes in the `user-api-key` header and
// is never logged. Money is sent as decimal strings ("12500.00").

export interface ChannelPropertyInput {
  title: string;
  currency: string;
  /** IANA name, e.g. Africa/Lagos (Channex certification needs it set). */
  timezone: string;
  propertyType: 'hotel';
  country?: string | undefined;
  city?: string | undefined;
  address?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
}

export interface ChannelRoomTypeInput {
  propertyId: string;
  title: string;
  countOfRooms: number;
  occAdults: number;
  defaultOccupancy: number;
}

export interface ChannelRatePlanInput {
  propertyId: string;
  roomTypeId: string;
  /** Unique per property in Channex. */
  title: string;
  currency: string;
  /** Per room, priced at this occupancy (the room type's maximum). */
  occupancy: number;
  mealType: 'room_only' | 'breakfast' | 'half_board' | 'full_board' | 'all_inclusive' | 'none';
}

/** Rooms left to sell of one room type over a range of dates (both included). */
export interface ChannelAvailabilityValue {
  propertyId: string;
  roomTypeId: string;
  dateFrom: string;
  dateTo: string;
  availability: number;
}

/** Price and restrictions of one rate plan over a range of dates (both included). */
export interface ChannelRestrictionValue {
  propertyId: string;
  ratePlanId: string;
  dateFrom: string;
  dateTo: string;
  /** Decimal string ("12500.00"); left out when there is no price (then stop-sell). */
  rate?: string | undefined;
  /** Nights, counted from arrival; 1 = no minimum. */
  minStayArrival: number;
  /** Nights, counted from arrival; 0 = no maximum. */
  maxStay: number;
  closedToArrival: boolean;
  closedToDeparture: boolean;
  stopSell: boolean;
}

/** What the channel manager said about a batch it accepted. */
export interface ChannelPushResult {
  taskId: string | null;
  /** Values it accepted but warned about (e.g. a date it ignored). */
  warnings: unknown[];
}

export interface ChannelManager {
  readonly name: 'OFF' | 'FAKE' | 'CHANNEX';
  createProperty(input: ChannelPropertyInput): Promise<{ id: string }>;
  createRoomType(input: ChannelRoomTypeInput): Promise<{ id: string }>;
  updateRoomType(id: string, input: Omit<ChannelRoomTypeInput, 'propertyId'>): Promise<void>;
  createRatePlan(input: ChannelRatePlanInput): Promise<{ id: string }>;
  /** T-152. Channex allows 10 calls a minute per property for each of these two. */
  updateAvailability(values: ChannelAvailabilityValue[]): Promise<ChannelPushResult>;
  updateRestrictions(values: ChannelRestrictionValue[]): Promise<ChannelPushResult>;
}

/** The channel manager refused or could not be reached; safe to show `message`. */
export class ChannelError extends Error {
  /** HTTP status, or null when the request never got an answer. */
  readonly status: number | null;
  /** Seconds to wait before trying again (429), when Channex says. */
  readonly retryAfterSeconds: number | null;
  /** Channex's validation details, field → messages (never contains the key). */
  readonly details: Record<string, unknown> | null;

  constructor(
    message: string,
    status: number | null,
    retryAfterSeconds: number | null = null,
    details: Record<string, unknown> | null = null,
  ) {
    super(message);
    this.name = 'ChannelError';
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.details = details;
  }

  /** Worth retrying later: rate limited, Channex down, or no answer. */
  get retryable(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

type Fetch = typeof fetch;

export function createChannexManager(options: {
  apiKey: string;
  baseUrl: string;
  fetch?: Fetch;
}): ChannelManager {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  async function request<T>(method: string, path: string, body?: object): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${options.baseUrl}${path}`, {
        method,
        headers: {
          'user-api-key': options.apiKey,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ChannelError('Channex could not be reached', null);
    }
    const json = (await res.json().catch(() => null)) as {
      errors?: { code?: string; title?: string; details?: Record<string, unknown> };
    } | null;
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const title = json?.errors?.title ?? res.statusText;
      throw new ChannelError(
        `Channex answered ${res.status}: ${title}`,
        res.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        json?.errors?.details ?? null,
      );
    }
    return json as T;
  }

  const idOf = (r: { data?: { id?: string } }) => {
    if (!r.data?.id) throw new ChannelError('Channex answered without an ID', 200);
    return { id: r.data.id };
  };

  /** ARI answers: {"data": [{"id": task, "type": "task"}], "meta": {"warnings": [...]}}. */
  const pushed = (r: {
    data?: { id?: string }[] | null;
    meta?: { warnings?: unknown[] } | null;
  }): ChannelPushResult => ({
    taskId: (Array.isArray(r.data) ? r.data[0]?.id : undefined) ?? null,
    warnings: Array.isArray(r.meta?.warnings) ? r.meta.warnings : [],
  });

  return {
    name: 'CHANNEX',
    async createProperty(p) {
      return idOf(
        await request('POST', '/properties', {
          property: {
            title: p.title,
            currency: p.currency,
            timezone: p.timezone,
            property_type: p.propertyType,
            ...(p.country ? { country: p.country } : {}),
            ...(p.city ? { city: p.city } : {}),
            ...(p.address ? { address: p.address } : {}),
            ...(p.email ? { email: p.email } : {}),
            ...(p.phone ? { phone: p.phone } : {}),
          },
        }),
      );
    },
    async createRoomType(r) {
      return idOf(
        await request('POST', '/room_types', {
          room_type: {
            property_id: r.propertyId,
            title: r.title,
            count_of_rooms: r.countOfRooms,
            occ_adults: r.occAdults,
            occ_children: 0,
            occ_infants: 0,
            default_occupancy: r.defaultOccupancy,
          },
        }),
      );
    },
    async updateRoomType(id, r) {
      await request('PUT', `/room_types/${encodeURIComponent(id)}`, {
        room_type: {
          title: r.title,
          count_of_rooms: r.countOfRooms,
          occ_adults: r.occAdults,
          occ_children: 0,
          occ_infants: 0,
          default_occupancy: r.defaultOccupancy,
        },
      });
    },
    async createRatePlan(r) {
      return idOf(
        await request('POST', '/rate_plans', {
          rate_plan: {
            property_id: r.propertyId,
            room_type_id: r.roomTypeId,
            title: r.title,
            currency: r.currency,
            sell_mode: 'per_room',
            rate_mode: 'manual',
            meal_type: r.mealType,
            options: [{ occupancy: r.occupancy, is_primary: true }],
          },
        }),
      );
    },
    async updateAvailability(values) {
      return pushed(
        await request('POST', '/availability', {
          values: values.map((v) => ({
            property_id: v.propertyId,
            room_type_id: v.roomTypeId,
            date_from: v.dateFrom,
            date_to: v.dateTo,
            availability: v.availability,
          })),
        }),
      );
    },
    async updateRestrictions(values) {
      return pushed(
        await request('POST', '/restrictions', {
          values: values.map((v) => ({
            property_id: v.propertyId,
            rate_plan_id: v.ratePlanId,
            date_from: v.dateFrom,
            date_to: v.dateTo,
            ...(v.rate !== undefined ? { rate: v.rate } : {}),
            min_stay_arrival: v.minStayArrival,
            max_stay: v.maxStay,
            closed_to_arrival: v.closedToArrival,
            closed_to_departure: v.closedToDeparture,
            stop_sell: v.stopSell,
          })),
        }),
      );
    },
  };
}

export function createOffChannelManager(): ChannelManager {
  const off = () => Promise.reject(new ChannelError('No channel manager is set up', null));
  return {
    name: 'OFF',
    createProperty: off,
    createRoomType: off,
    updateRoomType: off,
    createRatePlan: off,
    updateAvailability: off,
    updateRestrictions: off,
  };
}

export interface FakeChannelManager extends ChannelManager {
  /** Every call, in order, for tests. */
  readonly calls: { method: string; input: unknown }[];
  /** Makes the next call of `method` throw this error (once). */
  failNext: { method: string; error: ChannelError } | null;
  /** Warnings the next ARI call answers with (once). */
  warnNext: unknown[] | null;
}

/** Answers with new IDs and records every call; no network. */
export function createFakeChannelManager(): FakeChannelManager {
  const fake: FakeChannelManager = {
    name: 'FAKE',
    calls: [],
    failNext: null,
    warnNext: null,
    createProperty: (input) => record('createProperty', input),
    createRoomType: (input) => record('createRoomType', input),
    updateRoomType: async (id, input) => {
      await record('updateRoomType', { id, ...input });
    },
    createRatePlan: (input) => record('createRatePlan', input),
    updateAvailability: (values) => push('updateAvailability', values),
    updateRestrictions: (values) => push('updateRestrictions', values),
  };
  async function push(method: string, values: unknown): Promise<ChannelPushResult> {
    const { id } = await record(method, values);
    const warnings = fake.warnNext ?? [];
    fake.warnNext = null;
    return { taskId: id, warnings };
  }
  async function record(method: string, input: unknown) {
    fake.calls.push({ method, input });
    if (fake.failNext?.method === method) {
      const { error } = fake.failNext;
      fake.failNext = null;
      throw error;
    }
    return Promise.resolve({ id: randomUUID() });
  }
  return fake;
}

/** The channel manager the configuration names (CHANNEL_PROVIDER). */
export function createChannelManager(config: Pick<Config, 'channel'>): ChannelManager {
  const c = config.channel;
  if (c.provider === 'channex' && c.apiKey) {
    return createChannexManager({ apiKey: c.apiKey, baseUrl: c.baseUrl });
  }
  return c.provider === 'fake' ? createFakeChannelManager() : createOffChannelManager();
}
