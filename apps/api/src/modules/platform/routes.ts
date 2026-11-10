import { PLATFORM_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { getAuth, requireAuth } from '../../core/auth.ts';
import type { Config } from '../../core/config.ts';
import { AppError } from '../../core/errors.ts';
import { isPlatformAdmin } from '../../core/platform-admin.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { EmailProvider } from '../../core/email.ts';
import type { PaymentProvider } from '../../core/payments.ts';
import * as billing from './billing.ts';
import * as platform from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** Platform administration and the owner's billing page (tab 4 row "Platform"; T-100). */
export function platformRoutes(
  deps: platform.PlatformDeps & { config: Config; provider: PaymentProvider; email: EmailProvider },
): Router {
  const router = express.Router();
  const r = PLATFORM_ROUTES;

  // Platform staff only (PLATFORM_ADMIN_EMAILS with MFA on). Signed-out callers get the
  // route's own 401; signed-in non-staff are refused before anything is read.
  router.use('/platform', (req, _res, next) => {
    const auth = getAuth(req);
    if (auth && !isPlatformAdmin(deps.config, auth.user)) {
      throw new AppError('FORBIDDEN', 'Platform staff only.');
    }
    next();
  });

  mountRoute(router, r.listPlatformTenants, () => platform.listTenants(deps));
  mountRoute(router, r.getPlatformTenant, ({ params }) =>
    platform.getTenant(deps, params.organisationId),
  );
  mountRoute(router, r.setTenantSubscription, ({ params, body }, { req }) =>
    platform.setSubscription(deps, requireAuth(req), params.organisationId, body),
  );
  mountRoute(router, r.setTenantCountryPack, ({ params, body }, { req }) =>
    platform.setCountryPack(deps, requireAuth(req), params.organisationId, body.pack),
  );
  mountRoute(router, r.updateTenantFlags, ({ params, body }, { req }) =>
    platform.updateFlags(deps, requireAuth(req), params.organisationId, body.flags),
  );
  mountRoute(router, r.issuePlatformInvoice, ({ body }, { req }) =>
    platform.issueInvoice(deps, requireAuth(req), body),
  );
  mountRoute(router, r.updatePlatformInvoice, ({ params, body }, { req }) =>
    platform.updateInvoice(deps, requireAuth(req), params.invoiceId, body.status),
  );
  mountRoute(router, r.startSupportSession, ({ body }, { req }) =>
    platform.startSupport(deps, requireAuth(req), body),
  );
  mountRoute(router, r.endSupportSession, ({ params }, { req }) =>
    platform.endSupport(deps, requireAuth(req), params.sessionId),
  );

  mountRoute(router, r.getSubscription, (_req, { tenant }) =>
    platform.ownerSubscription(deps, tenantFrom(tenant)),
  );
  mountRoute(router, r.updateBillingDetails, ({ body }, { tenant }) =>
    platform.updateBilling(deps, tenantFrom(tenant), body.legalName),
  );
  mountRoute(router, r.getPlatformInvoicePdf, ({ params }, { tenant }) =>
    platform.invoicePdf(deps, tenantFrom(tenant), params.invoiceId),
  );

  // Automated billing and suspension (M13-03 from V1.2, M13-06; T-124).
  mountRoute(router, r.payPlatformInvoice, ({ params }, { tenant }) =>
    billing.payLink(deps, tenantFrom(tenant), params.invoiceId),
  );
  mountRoute(router, r.checkPlatformInvoice, ({ params }, { tenant }) =>
    billing.checkPayment(deps, tenantFrom(tenant), params.invoiceId),
  );
  mountRoute(router, r.suspendTenant, ({ params, body }, { req }) =>
    billing.suspend(deps, requireAuth(req), params.organisationId, body.reason),
  );
  mountRoute(router, r.reactivateTenant, ({ params, body }, { req }) =>
    billing.reactivate(deps, requireAuth(req), params.organisationId, body.reason),
  );

  return router;
}
