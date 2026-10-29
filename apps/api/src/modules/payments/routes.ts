import { PAYMENT_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { folioInvoice, folioReceipt, proforma } from './documents.ts';
import * as payments from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Payments and folio documents (tab 4 rows "Payments" and "Folios"; T-062). */
export function paymentRoutes(deps: payments.PaymentDeps): Router {
  const router = express.Router();
  const r = PAYMENT_ROUTES;

  mountRoute(router, r.capturePayment, ({ body }, { tenant }) =>
    payments.capturePayment(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.getFolioInvoice, ({ params, query }) =>
    folioInvoice(deps, params.folioId, query.window),
  );
  mountRoute(router, r.getFolioReceipt, ({ params, query }) =>
    folioReceipt(deps, params.folioId, query.paymentId),
  );
  mountRoute(router, r.getProforma, ({ params }) => proforma(deps, params.reservationId));

  return router;
}
