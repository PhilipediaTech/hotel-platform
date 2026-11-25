import { EINVOICE_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as einvoicing from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** E-invoicing (M4-24; T-160): finance's list, sending, and the switch. */
export function einvoiceRoutes(deps: einvoicing.EinvoiceDeps): Router {
  const router = express.Router();
  const r = EINVOICE_ROUTES;
  mountRoute(router, r.getEinvoiceSettings, (_input, { tenant }) =>
    einvoicing.getSettings(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.updateEinvoiceSettings, ({ body }, { tenant }) =>
    einvoicing.updateSettings(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.listEinvoices, ({ query }, { tenant }) =>
    einvoicing.listEinvoices(deps, tenantFrom(tenant), query.status),
  );
  mountRoute(router, r.submitEinvoice, ({ params }, { tenant }) =>
    einvoicing.submitEinvoice(deps, tenantFrom(tenant), params.folioId, params.windowNumber),
  );
  return router;
}
