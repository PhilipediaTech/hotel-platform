import { GETTING_STARTED_ROUTES, HELP_ROUTES, ONBOARDING_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { getAuth, requireAuth } from '../../core/auth.ts';
import type { Config } from '../../core/config.ts';
import { AppError } from '../../core/errors.ts';
import { isPlatformAdmin } from '../../core/platform-admin.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as gettingStarted from './getting-started.ts';
import * as help from './help.ts';
import * as onboarding from './service.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

/** The onboarding tracker and training sessions (T-171). */
export function onboardingRoutes(
  deps: onboarding.OnboardingDeps & { config: Pick<Config, 'platformAdminEmails'> },
): Router {
  const router = express.Router();
  const r = ONBOARDING_ROUTES;

  // Platform staff only, as for the rest of /platform (platform/routes.ts).
  router.use(
    ['/platform/onboarding', '/platform/tenants', '/platform/training', '/platform/help'],
    (req, _res, next) => {
      const auth = getAuth(req);
      if (auth && !isPlatformAdmin(deps.config, auth.user)) {
        throw new AppError('FORBIDDEN', 'Platform staff only.');
      }
      next();
    },
  );

  mountRoute(router, r.listOnboarding, () => onboarding.listOnboarding(deps));
  mountRoute(router, r.listTenantTraining, ({ params }) =>
    onboarding.listTenantTraining(deps, params.organisationId),
  );
  mountRoute(router, r.bookTraining, ({ params, body }, { req }) =>
    onboarding.bookSession(deps, requireAuth(req), params.organisationId, body),
  );
  mountRoute(router, r.markTrainingHeld, ({ params }, { req }) =>
    onboarding.markHeld(deps, requireAuth(req), params.sessionId),
  );
  mountRoute(router, r.cancelTraining, ({ params }, { req }) =>
    onboarding.cancelSession(deps, requireAuth(req), params.sessionId),
  );
  mountRoute(router, r.listMyTraining, () => onboarding.myTraining(deps));

  // Getting started (T-172).
  mountRoute(router, GETTING_STARTED_ROUTES.listGettingStarted, (_req, { tenant }) =>
    gettingStarted.mySteps(deps, tenantFrom(tenant)),
  );
  mountRoute(router, GETTING_STARTED_ROUTES.listTeamGettingStarted, (_req, { tenant }) =>
    gettingStarted.teamSteps(deps, tenantFrom(tenant)),
  );

  // Help centre (T-173).
  const h = HELP_ROUTES;
  mountRoute(router, h.listHelpArticles, ({ query }) => help.listArticles(deps, query));
  mountRoute(router, h.getHelpArticle, ({ params }) => help.getArticle(deps, params.slug));
  mountRoute(router, h.listPlatformHelpArticles, () => help.listAllArticles(deps));
  mountRoute(router, h.createHelpArticle, ({ body }, { req }) =>
    help.createArticle(deps, requireAuth(req), body),
  );
  mountRoute(router, h.updateHelpArticle, ({ params, body }, { req }) =>
    help.updateArticle(deps, requireAuth(req), params.articleId, body),
  );
  return router;
}
