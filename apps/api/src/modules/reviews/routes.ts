import { REVIEW_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as reviews from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Guest reviews (M14-15; T-155): the GM's screen, and the guest's page (public, by link). */
export function reviewRoutes(deps: reviews.ReviewDeps): Router {
  const router = express.Router();
  const r = REVIEW_ROUTES;
  mountRoute(router, r.getReviewSettings, (_input, { tenant }) =>
    reviews.getReviewSettings(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.updateReviewSettings, ({ body }, { tenant }) =>
    reviews.updateReviewSettings(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.listReviews, ({ query }) => reviews.listReviews(deps, query));
  mountRoute(router, r.draftReviewReply, ({ params }, { tenant }) =>
    reviews.draftReviewReply(deps, tenantFrom(tenant), params.reviewId),
  );
  mountRoute(router, r.replyToReview, ({ params, body }, { tenant }) =>
    reviews.replyToReview(deps, tenantFrom(tenant), params.reviewId, body),
  );
  mountRoute(router, r.getPublicReview, ({ params }) =>
    reviews.getPublicReview(deps, params.token),
  );
  mountRoute(router, r.submitPublicReview, ({ params, body }) =>
    reviews.submitPublicReview(deps, params.token, body),
  );
  return router;
}
