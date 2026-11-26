import { ONBOARDING_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import { getAuth, requireAuth } from '../../core/auth.ts';
import type { Config } from '../../core/config.ts';
import { AppError } from '../../core/errors.ts';
import { isPlatformAdmin } from '../../core/platform-admin.ts';
import { mountRoute } from '../../core/route.ts';
import * as onboarding from './service.ts';

/** The onboarding tracker and training sessions (T-171). */
export function onboardingRoutes(
  deps: onboarding.OnboardingDeps & { config: Pick<Config, 'platformAdminEmails'> },
): Router {
  const router = express.Router();
  const r = ONBOARDING_ROUTES;

  // Platform staff only, as for the rest of /platform (platform/routes.ts).
  router.use(
    ['/platform/onboarding', '/platform/tenants', '/platform/training'],
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
  return router;
}
