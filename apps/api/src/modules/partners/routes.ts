import { PARTNER_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { requireAuth } from '../../core/auth.ts';
import { mountRoute } from '../../core/route.ts';
import * as partners from './service.ts';

/** Referral partners (M14-06–M14-08; T-110). /platform/* is guarded by platformRoutes. */
export function partnerRoutes(deps: partners.PartnerDeps): Router {
  const router = express.Router();
  const r = PARTNER_ROUTES;
  mountRoute(router, r.listPartners, () => partners.listPartners(deps));
  mountRoute(router, r.createPartner, ({ body }, { req }) =>
    partners.createPartner(deps, requireAuth(req), body),
  );
  mountRoute(router, r.getPartner, ({ params }) => partners.getPartner(deps, params.partnerId));
  mountRoute(router, r.updatePartner, ({ params, body }, { req }) =>
    partners.updatePartner(deps, requireAuth(req), params.partnerId, body),
  );
  mountRoute(router, r.recordPartnerPayout, ({ params, body }, { req }) =>
    partners.recordPayout(deps, requireAuth(req), params.partnerId, body),
  );
  mountRoute(router, r.getTenantPartner, ({ params }) =>
    partners.getTenantPartner(deps, params.organisationId),
  );
  mountRoute(router, r.setTenantPartner, ({ params, body }, { req }) =>
    partners.setTenantPartner(deps, requireAuth(req), params.organisationId, body),
  );
  mountRoute(router, r.getPartnerHome, (_req, { req }) =>
    partners.partnerHome(deps, requireAuth(req)),
  );
  return router;
}
