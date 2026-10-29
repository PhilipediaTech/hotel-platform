import { AUTH_ROUTES } from '@hotel/shared';
import express, { type Request, type Response, type Router } from 'express';
import type { Session } from '../../generated/prisma/client.ts';
import {
  clearDeviceCookie,
  clearSessionCookie,
  getAuth,
  loadDeviceSession,
  requireAuth,
  revokeSessionTree,
  setDeviceCookie,
  setSessionCookie,
} from '../../core/auth.ts';
import { AppError } from '../../core/errors.ts';
import { mountRoute } from '../../core/route.ts';
import * as mfa from './mfa.ts';
import * as pin from './pin.ts';
import * as identity from './service.ts';

/** Auth and "me" endpoints (tab 4 rows Auth and Me; T-010, T-011). */
export function identityRoutes(deps: identity.IdentityDeps): Router {
  const router = express.Router();
  const r = AUTH_ROUTES;

  /** This browser's shared device, if it is still one staff may PIN into. */
  async function activeDevice(req: Request): Promise<Session | null> {
    const device = await loadDeviceSession(deps, req);
    return device && (await pin.deviceAllowed(deps, device)) ? device : null;
  }

  /** Ends the browser's current session (never the device: that lives only in `did`). */
  async function endCurrentSession(req: Request): Promise<void> {
    const current = getAuth(req);
    if (current) await revokeSessionTree(deps.db, current.session.id, deps.clock());
  }

  /**
   * A manager's MFA-passed "shared device" sign-in opens this browser's device: a DEVICE
   * session in `did` (replacing any earlier one here, with its sessions), the manager's own
   * session moved under it. Returns the manager's updated session, or null if not a device.
   */
  async function adoptDevice(
    req: Request,
    res: Response,
    session: Session,
  ): Promise<Session | null> {
    if (!session.sharedDevice || session.parentSessionId || !session.mfaPassed) return null;
    if (!(await pin.deviceAllowed(deps, session))) return null;
    const previous = await loadDeviceSession(deps, req);
    if (previous) await revokeSessionTree(deps.db, previous.id, deps.clock());
    const opened = await pin.openDevice(deps, session);
    setDeviceCookie(res, deps.config, opened.deviceToken, opened.device.expiresAt);
    return opened.session;
  }

  /** `deviceJustOpened`: the device cookie is in this response, not yet in the request. */
  const me = async (
    req: Request,
    user: Parameters<typeof identity.buildMe>[1],
    session: Session,
    deviceJustOpened = false,
  ) =>
    identity.buildMe(deps.db, user, session, {
      pinSwitchAvailable: deviceJustOpened || (await activeDevice(req)) !== null,
      clock: deps.clock,
    });

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
    const result = await identity.signIn(deps, body, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    // Whoever was signed in on this browser is replaced (the shared device itself stays).
    await endCurrentSession(req);
    const adopted = await adoptDevice(req, res, result.session);
    const session = adopted ?? result.session;
    setSessionCookie(res, deps.config, result.token, session.expiresAt);
    return me(req, result.user, session, adopted !== null);
  });

  mountRoute(router, r.signOut, async ({ body }, { req, res }) => {
    const current = getAuth(req);
    if (current) {
      const device = await loadDeviceSession(deps, req);
      const onDevice = device !== null && current.session.parentSessionId === device.id;
      if (onDevice && device.userId === current.user.id && !body.keepDevice) {
        // The manager who opened the device signing out closes it and every session on it.
        await revokeSessionTree(deps.db, device.id, deps.clock());
        clearDeviceCookie(res, deps.config);
      } else {
        // Anyone else, or "Switch user": only this session ends; the device waits for a PIN.
        await revokeSessionTree(deps.db, current.session.id, deps.clock());
      }
    }
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
    const { user, session } = requireAuth(req, { allowPendingMfa: true });
    return me(req, user, session);
  });

  mountRoute(router, r.listMySessions, async (_input, { req }) => ({
    data: await identity.listMySessions(deps, requireAuth(req)),
  }));

  mountRoute(router, r.revokeMySession, ({ params }, { req }) =>
    identity.revokeMySession(deps, requireAuth(req), params.sessionId),
  );

  // MFA (M1-06) ---------------------------------------------------------------------------

  mountRoute(router, r.enrolMfa, (_input, { req }) =>
    mfa.enrolMfa(deps, requireAuth(req, { allowPendingMfa: true })),
  );

  mountRoute(router, r.confirmMfa, async ({ body }, { req, res }) => {
    const { recoveryCodes, session, token } = await mfa.confirmMfa(
      deps,
      requireAuth(req, { allowPendingMfa: true }),
      body.code,
    );
    const adopted = await adoptDevice(req, res, session);
    setSessionCookie(res, deps.config, token, (adopted ?? session).expiresAt);
    return { recoveryCodes };
  });

  mountRoute(router, r.verifyMfa, async ({ body }, { req, res }) => {
    const { user, session, token } = await mfa.verifyMfa(
      deps,
      requireAuth(req, { allowPendingMfa: true }),
      body,
    );
    const adopted = await adoptDevice(req, res, session);
    setSessionCookie(res, deps.config, token, (adopted ?? session).expiresAt);
    return me(req, user, adopted ?? session, adopted !== null);
  });

  // PIN switch on shared devices (M1-07) --------------------------------------------------

  mountRoute(router, r.setMyPin, ({ body }, { req }) => pin.setMyPin(deps, requireAuth(req), body));

  mountRoute(router, r.getDevice, async (_input, { req }) => {
    const device = await activeDevice(req);
    return { pinSwitchAvailable: device !== null, deviceLabel: device?.deviceLabel ?? null };
  });

  mountRoute(router, r.pinSwitch, async ({ body }, { req, res }) => {
    const device = await activeDevice(req);
    if (!device) {
      throw new AppError('FORBIDDEN', 'This is not a shared device. Sign in with your password.', {
        reason: 'NO_SHARED_DEVICE',
      });
    }
    const { user, session, token } = await pin.pinSwitch(deps, device, body, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
    });
    await endCurrentSession(req);
    setSessionCookie(res, deps.config, token, session.expiresAt);
    return me(req, user, session);
  });

  return router;
}
