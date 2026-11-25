import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, IsoDate, Uuid } from './primitives.ts';

// Guest reviews (PRD M14-15 "As a guest, after check-out I get a review request; as a GM, I see
// reviews and a drafted reply I can edit before it is sent"; T-155). The hotel's own reviews:
// once a guest has checked out (and the hotel has switched requests on), they get one message
// with a private link to a short review page: stars and a comment. The GM sees each review
// with a reply the AI drafted, edits it, and sends it to the guest. The page also offers every
// guest (not only happy ones) the hotel's public review link, when one is set.

const ADDED = 'Not in tab 4: designed in T-155 (PRD M14-15).';

export const ReviewSettings = z
  .object({
    /** Ask guests for a review after check-out. Off until the hotel switches it on. */
    enabled: z.boolean(),
    /** Hours after check-out before the request goes (1–72). */
    delayHours: z.number().int().min(1).max(72),
    /** Where guests can also post a public review (Google, TripAdvisor…); offered to all. */
    publicReviewUrl: z
      .url({ protocol: /^https$/, error: 'An https:// address' })
      .max(500)
      .nullable(),
  })
  .meta({ id: 'ReviewSettings' });

export const REVIEW_STATUSES = ['REQUESTED', 'WAITING', 'REPLIED'] as const;

export const ReviewItem = z
  .object({
    id: Uuid,
    /** REQUESTED: no answer yet; WAITING: reviewed, no reply sent; REPLIED. */
    status: z.enum(REVIEW_STATUSES),
    guest: z.object({ id: Uuid, name: z.string() }),
    confirmationNo: z.string(),
    arrival: IsoDate,
    departure: IsoDate,
    /** How the request went. */
    channel: z.enum(['EMAIL', 'WHATSAPP', 'PORTAL']),
    requestedAt: Instant,
    rating: z.number().int().min(1).max(5).nullable(),
    comment: z.string().nullable(),
    submittedAt: Instant.nullable(),
    /** The AI's draft, for the GM to edit; null when AI is off or still drafting. */
    draft: z.string().nullable(),
    reply: z.string().nullable(),
    repliedAt: Instant.nullable(),
    repliedBy: z.object({ id: Uuid, name: z.string() }).nullable(),
  })
  .meta({ id: 'Review' });

export const ReviewList = z
  .object({
    data: z.array(ReviewItem),
    summary: z.object({
      /** Requests sent in the last 90 days, and how many of them were answered. */
      requested: z.number().int(),
      answered: z.number().int(),
      /** Average stars of the answers in the last 90 days, null with none. */
      averageRating: z.number().nullable(),
      /** Reviews waiting for a reply. */
      waiting: z.number().int(),
    }),
  })
  .meta({ id: 'ReviewList' });

const MANAGE = {
  tags: ['Reviews'],
  propertyScoped: true as const,
  permission: 'review.manage',
};

export const getReviewSettings = defineRoute({
  ...MANAGE,
  operationId: 'getReviewSettings',
  method: 'get',
  path: '/review-settings',
  summary: 'Whether guests are asked for a review, when, and the public review link',
  description: ADDED,
  response: ReviewSettings,
});

export const updateReviewSettings = defineRoute({
  ...MANAGE,
  operationId: 'updateReviewSettings',
  method: 'put',
  path: '/review-settings',
  summary: 'Switch review requests on or off, and set when they go and the public link',
  description: `${ADDED} Switching on asks only guests who check out from then on.`,
  body: ReviewSettings,
  response: ReviewSettings,
});

export const listReviews = defineRoute({
  ...MANAGE,
  operationId: 'listReviews',
  method: 'get',
  path: '/reviews',
  summary: 'Reviews, newest first: waiting for a reply, replied, or requests not answered',
  description: ADDED,
  query: z.object({ status: z.enum(REVIEW_STATUSES).optional() }),
  response: ReviewList,
});

const ReviewParams = z.object({ reviewId: Uuid });

export const draftReviewReply = defineRoute({
  ...MANAGE,
  operationId: 'draftReviewReply',
  method: 'post',
  path: '/reviews/{reviewId}/draft',
  summary: 'Draft the reply again with AI',
  description: `${ADDED} 409 once replied, or before the guest has reviewed; 503 AI_UNAVAILABLE when AI is off, unreachable, or the month's allowance is used up.`,
  idempotent: true,
  params: ReviewParams,
  response: ReviewItem,
  errors: ['STATE_TRANSITION_INVALID', 'AI_UNAVAILABLE'],
});

export const replyToReview = defineRoute({
  ...MANAGE,
  operationId: 'replyToReview',
  method: 'post',
  path: '/reviews/{reviewId}/reply',
  summary: 'Send the reply to the guest (by email, else WhatsApp); once',
  description: `${ADDED} 409 once replied, or before the guest has reviewed.`,
  idempotent: true,
  params: ReviewParams,
  body: z.object({ reply: z.string().trim().min(1, 'Write the reply').max(2000) }),
  response: ReviewItem,
  errors: ['STATE_TRANSITION_INVALID'],
});

// ── The guest's page (public: the link is the key) ─────────────────────────────────────

export const PublicReview = z
  .object({
    hotelName: z.string(),
    guestFirstName: z.string(),
    arrival: IsoDate,
    departure: IsoDate,
    /** The link has run out (30 days) and no review was given. */
    expired: z.boolean(),
    review: z
      .object({
        rating: z.number().int().min(1).max(5),
        comment: z.string().nullable(),
        submittedAt: Instant,
      })
      .nullable(),
    /** The hotel's reply, once sent. */
    reply: z.string().nullable(),
    /** Where the guest can also post a public review; null when the hotel set none. */
    publicReviewUrl: z.string().nullable(),
  })
  .meta({ id: 'PublicReview' });

const PUBLIC = { tags: ['Public reviews'], auth: 'none' as const };
const TokenParams = z.object({ token: z.string().min(20).max(100) });

export const getPublicReview = defineRoute({
  ...PUBLIC,
  operationId: 'getPublicReview',
  method: 'get',
  path: '/public/reviews/{token}',
  summary: 'The guest’s review page: their stay, and their review and the reply once given',
  description: `${ADDED} 404 for an unknown link.`,
  params: TokenParams,
  response: PublicReview,
});

export const submitPublicReview = defineRoute({
  ...PUBLIC,
  operationId: 'submitPublicReview',
  method: 'post',
  path: '/public/reviews/{token}',
  summary: 'The guest gives their review: 1 to 5 stars and a comment; once',
  description: `${ADDED} 409 once given, or after the link ran out (30 days).`,
  params: TokenParams,
  body: z.object({
    rating: z.number().int().min(1, 'Choose 1 to 5 stars').max(5),
    comment: z.string().trim().max(2000).nullable().default(null),
  }),
  response: PublicReview,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const REVIEW_ROUTES = {
  getReviewSettings,
  updateReviewSettings,
  listReviews,
  draftReviewReply,
  replyToReview,
  getPublicReview,
  submitPublicReview,
} as const;
