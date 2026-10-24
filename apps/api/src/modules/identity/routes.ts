import { AUTH_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import {
  clearSessionCookie,
  requireAuth,
  revokeCurrentSession,
  setSessionCookie,
} from '../../core/auth.ts';
import { mountRoute } from '../../core/route.ts';
import * as identity from './service.ts';

/** Auth and "me" endpoints (tab 4 rows Auth and Me). */
export function identityRoutes(deps: identity.IdentityDeps): Router {
  const router = express.Router();
  const r = AUTH_ROUTES;

  mountRoute(router, r.signUp, async ({ body }) => {
    await identity.signUp(deps, body);
    return { verificationSent: true as const };
  });

  mountRoute(router, r.verifyEmail, ({ body }) => identity.verifyEmail(deps, body.token));

  mountRoute(router, r.resendVerification, async ({ body }) => {
    await identity.resendVerification(deps, body.email);
    return { accepted: true as const };
  });

  mountRoute(router, r.signIn, async ({ body }, { req, res }) => {
    const { user, session, token } = await identity.signIn(deps, body, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    // A browser that was signed in as someone else keeps only the new session.
    await revokeCurrentSession(deps.db, req, deps.clock());
    setSessionCookie(res, deps.config, token, session.expiresAt);
    return identity.buildMe(deps.db, user, session);
  });

  mountRoute(router, r.signOut, async (_input, { req, res }) => {
    await revokeCurrentSession(deps.db, req, deps.clock());
    clearSessionCookie(res, deps.config);
  });

  mountRoute(router, r.requestPasswordReset, async ({ body }) => {
    await identity.requestPasswordReset(deps, body.email);
    return { accepted: true as const };
  });

  mountRoute(router, r.resetPassword, ({ body }) =>
    identity.resetPassword(deps, body.token, body.password),
  );

  mountRoute(router, r.getMe, (_input, { req }) => {
    const { user, session } = requireAuth(req);
    return identity.buildMe(deps.db, user, session);
  });

  mountRoute(router, r.listMySessions, async (_input, { req }) => ({
    data: await identity.listMySessions(deps, requireAuth(req)),
  }));

  mountRoute(router, r.revokeMySession, ({ params }, { req }) =>
    identity.revokeMySession(deps, requireAuth(req), params.sessionId),
  );

  return router;
}
