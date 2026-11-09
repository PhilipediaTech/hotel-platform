import type {
  getPublicAvailability,
  OnlineCheckInBody,
  OnlineCheckInInfo,
  PublicBooking,
  PublicBookingBody,
  PublicBookingCreated,
  PublicProperty,
} from '@hotel/shared';
import type { z } from 'zod';

// The booking page's calls to the public API (tab 4 "Public booking"; T-113). Types only come
// from the shared package, so none of its code reaches a guest's phone.

export type Property = z.output<typeof PublicProperty>;
export type Availability = z.output<(typeof getPublicAvailability)['response']>;
export type Booking = z.output<typeof PublicBooking>;
export type Created = z.output<typeof PublicBookingCreated>;
export type BookingRequest = z.input<typeof PublicBookingBody>;
export type CheckInInfo = z.output<typeof OnlineCheckInInfo>;
export type CheckInRequest = z.input<typeof OnlineCheckInBody>;

export interface SearchRequest {
  slug: string;
  arrival: string;
  departure: string;
  adults: number;
  children: number;
  promo?: string;
}

export interface Api {
  property(slug: string): Promise<Property>;
  availability(search: SearchRequest): Promise<Availability>;
  book(body: BookingRequest): Promise<Created>;
  booking(token: string): Promise<Booking>;
  cancel(token: string, acceptedFeeMinor: string): Promise<Booking>;
  checkInInfo(token: string): Promise<CheckInInfo>;
  submitCheckIn(token: string, body: CheckInRequest): Promise<CheckInInfo>;
  /** Sends the ID straight to storage and answers its file ID. */
  uploadId(token: string, file: File): Promise<string>;
  payBalance(token: string, returnUrl: string): Promise<{ paymentUrl: string }>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: Record<string, unknown>;

  constructor(
    status: number,
    message: string,
    code: string | null,
    details: Record<string, unknown>,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const OFFLINE =
  'We can’t reach the booking system. Check your connection and try again. You have not been charged.';

interface ErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown> & { issues?: { message?: string }[] };
  };
}

async function call<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}/public/v1${path}`, init);
  } catch {
    throw new ApiError(0, OFFLINE, null, {});
  }
  if (res.ok) return (await res.json()) as T;
  const body = (await res.json().catch(() => ({}))) as ErrorBody;
  const details = body.error?.details ?? {};
  // A field problem is more use to the guest than "validation failed".
  const message =
    details.issues?.[0]?.message ??
    body.error?.message ??
    'Something went wrong. Please try again.';
  throw new ApiError(res.status, message, body.error?.code ?? null, details);
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export function createApi(base: string): Api {
  return {
    property: (slug) => call(base, `/properties/${encodeURIComponent(slug)}`),
    availability: (s) => {
      const q = new URLSearchParams({
        slug: s.slug,
        arrival: s.arrival,
        departure: s.departure,
        adults: String(s.adults),
        children: String(s.children),
        ...(s.promo ? { promo: s.promo } : {}),
      });
      return call(base, `/availability?${q.toString()}`);
    },
    book: (body) => call(base, '/bookings', post(body)),
    booking: (token) => call(base, `/bookings/${encodeURIComponent(token)}`),
    cancel: (token, acceptedFeeMinor) =>
      call(base, `/bookings/${encodeURIComponent(token)}/cancel`, post({ acceptedFeeMinor })),
    checkInInfo: (token) => call(base, `/bookings/${encodeURIComponent(token)}/check-in`),
    submitCheckIn: (token, body) =>
      call(base, `/bookings/${encodeURIComponent(token)}/check-in`, post(body)),
    payBalance: (token, returnUrl) =>
      call(base, `/bookings/${encodeURIComponent(token)}/pay`, post({ returnUrl })),
    uploadId: async (token, file) => {
      const link = await call<{
        fileId: string;
        method: string;
        url: string;
        headers: Record<string, string>;
      }>(
        base,
        `/bookings/${encodeURIComponent(token)}/check-in/id-upload`,
        post({ contentType: file.type, sizeBytes: file.size }),
      );
      const sent = await fetch(link.url, {
        method: link.method,
        headers: link.headers,
        body: file,
      });
      if (!sent.ok)
        throw new ApiError(sent.status, 'The upload failed. Please try again.', null, {});
      return link.fileId;
    },
  };
}
