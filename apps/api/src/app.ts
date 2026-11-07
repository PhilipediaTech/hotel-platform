import { getOpenApiDocument } from '@hotel/shared';
import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import {
  createBreachedPasswordCheck,
  type BreachedPasswordCheck,
} from './core/breached-passwords.ts';
import { auditContext } from './core/audit.ts';
import { idempotencyStore } from './core/idempotency.ts';
import { sessionLoader } from './core/auth.ts';
import { systemClock, type Clock } from './core/clock.ts';
import type { Config } from './core/config.ts';
import { originCheck } from './core/csrf.ts';
import type { Db } from './core/db.ts';
import type { EmailProvider } from './core/email.ts';
import { LOCAL_FILES_PATH, type FileStore, type LocalFileStore } from './core/files.ts';
import { fileRoutes } from './modules/files/routes.ts';
import { errorHandler, notFoundHandler } from './core/errors.ts';
import { httpLogger } from './core/logger.ts';
import { openApiDocument } from './core/openapi.ts';
import { rateLimiter } from './core/rate-limit.ts';
import { createTenantDb } from './core/tenant-db.ts';
import { tenancyContext } from './core/tenancy.ts';
import { requestId } from './core/request-id.ts';
import { mountRoute } from './core/route.ts';
import { accessRoutes } from './modules/access/routes.ts';
import { auditRoutes } from './modules/audit/routes.ts';
import { approvalRoutes } from './modules/approvals/routes.ts';
import { approvalHandlers as defaultApprovalHandlers } from './approval-actions.ts';
import type { ApprovalActionHandler } from './core/approvals.ts';
import { identityRoutes } from './modules/identity/routes.ts';
import { availabilityRoutes } from './modules/availability/routes.ts';
import { guestRoutes } from './modules/guests/routes.ts';
import { importRoutes } from './modules/imports/routes.ts';
import { rateRoutes } from './modules/rates/routes.ts';
import { folioRoutes } from './modules/folios/routes.ts';
import { shiftRoutes } from './modules/shifts/routes.ts';
import { paymentRoutes } from './modules/payments/routes.ts';
import { fxRoutes } from './modules/fx/routes.ts';
import { nightAuditRoutes } from './modules/nightaudit/routes.ts';
import { housekeepingRoutes } from './modules/housekeeping/routes.ts';
import { taskRoutes } from './modules/tasks/routes.ts';
import { handoverRoutes } from './modules/handovers/routes.ts';
import { leakageRoutes } from './modules/leakage/routes.ts';
import { messagingRoutes } from './modules/notifications/routes.ts';
import { ownerRoutes } from './modules/owner/routes.ts';
import { reportRoutes } from './modules/reports/routes.ts';
import { platformRoutes } from './modules/platform/routes.ts';
import type { MessageProvider } from './core/messaging.ts';
import { paymentIntentRoutes } from './modules/payments/intent-routes.ts';
import { RAW_BODY, webhookRoutes } from './modules/payments/webhook-routes.ts';
import type { PaymentProvider } from './core/payments.ts';
import { reservationRoutes } from './modules/reservations/routes.ts';
import { roomRoutes } from './modules/rooms/routes.ts';
import { setupRoutes } from './modules/setup/routes.ts';
import { taxRoutes } from './modules/tax/routes.ts';

export const BODY_LIMIT = '100kb';

export interface AppOptions {
  config: Config;
  logger: Logger;
  db: Db;
  email: EmailProvider;
  /** Payment links (ADR-021: Paystack; the fake locally and in tests). */
  payments: PaymentProvider;
  /** WhatsApp (ADR-016: Meta Cloud API; the fake locally and in tests). */
  messages: MessageProvider;
  /** File storage (R2 in production); the local store also serves its signed links. */
  files: FileStore | LocalFileStore;
  clock?: Clock;
  /** New passwords against known breaches (T-102); built from config when left out. */
  breachedPasswords?: BreachedPasswordCheck;
  /** Extra routes mounted under /api/v1 after the modules (tests use this). */
  routes?: Router;
  /** Protected actions the approvals engine executes (tests add their own). */
  approvalHandlers?: readonly ApprovalActionHandler<never>[];
}

/** Middleware order follows spec tab 2, "Request lifecycle". */
export function createApp({
  config,
  logger,
  db,
  email,
  payments,
  messages,
  files,
  clock = systemClock,
  routes,
  approvalHandlers,
  breachedPasswords = createBreachedPasswordCheck(config, logger),
}: AppOptions): Express {
  const app = express();
  app.disable('x-powered-by');
  // Render terminates TLS one proxy hop in front of us; needed for real client IPs.
  if (config.nodeEnv === 'production') app.set('trust proxy', 1);

  // 1. Request ID
  app.use(requestId());
  // 2. Logger
  app.use(httpLogger(logger));
  // 3. Security headers and CORS allow-list (app and site origins only)
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(
    cors({
      origin: [config.appOrigin, config.siteOrigin],
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'ETag', 'Retry-After'],
      maxAge: 600,
    }),
  );
  // Signed upload and download links of the local file store. They stand in for direct
  // requests to storage, so they skip the session, tenancy and rate-limit steps below.
  if ('router' in files) app.use(LOCAL_FILES_PATH, files.router());

  // 4. Body parser with size limit
  app.use(
    express.json({
      limit: BODY_LIMIT,
      // Webhook signatures are over the exact bytes received (T-071).
      verify: (req, _res, buf) => {
        if (req.url?.startsWith('/api/v1/webhooks/')) {
          (req as unknown as Record<symbol, Buffer>)[RAW_BODY] = Buffer.from(buf);
        }
      },
    }),
  );
  // 5. Session load (cookie → sessions row)
  app.use(sessionLoader({ db, config, clock }));
  // Request facts (request ID, IP, device, user) for audit events.
  app.use(auditContext());
  // 6. CSRF: Origin must be allow-listed on every non-GET
  app.use(originCheck(config));
  // 7. Tenancy context: X-Property-Id → membership → AsyncLocalStorage
  app.use(tenancyContext({ db, clock, config }));
  // 8. Rate limiter (per IP on auth routes, per user)
  app.use(rateLimiter({ db, clock, logger }));

  // Idempotency-Key store for the ● routes (T-020); mountRoute uses it.
  app.use(idempotencyStore({ db, clock }));

  // 9. Routes
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  const api = express.Router();
  // Spread: the generator types the document as an interface, which lacks an index signature.
  mountRoute(api, getOpenApiDocument, () => ({ ...openApiDocument() }));
  api.use(identityRoutes({ db, config, clock, email, logger, messages, breachedPasswords }));
  // Module code reads and writes tenant tables through the tenant-scoped client (T-012).
  const tenantDb = createTenantDb(db);
  api.use(accessRoutes({ db, tenantDb, config, clock, email, logger, breachedPasswords }));
  api.use(auditRoutes({ tenantDb }));
  api.use(
    approvalRoutes({
      db,
      tenantDb,
      clock,
      handlers: approvalHandlers ?? defaultApprovalHandlers({ db, tenantDb, clock }),
      otpSecret: config.sessionSecret,
    }),
  );
  api.use(fileRoutes({ tenantDb, store: files, clock }));
  api.use(setupRoutes({ db, clock }));
  api.use(roomRoutes({ db, tenantDb, clock }));
  api.use(taxRoutes({ db, tenantDb, clock }));
  api.use(rateRoutes({ db, tenantDb, clock }));
  api.use(importRoutes({ db, tenantDb, store: files, clock }));
  api.use(availabilityRoutes({ db, tenantDb, clock }));
  api.use(guestRoutes({ tenantDb, clock }));
  api.use(reservationRoutes({ db, tenantDb, clock, idKey: config.idKey }));
  api.use(folioRoutes({ db, tenantDb, clock }));
  api.use(shiftRoutes({ db, tenantDb, clock }));
  api.use(paymentRoutes({ db, tenantDb, clock }));
  api.use(fxRoutes({ db, tenantDb, clock }));
  api.use(nightAuditRoutes({ db, tenantDb, clock, logger }));
  api.use(housekeepingRoutes({ db, tenantDb, clock }));
  api.use(taskRoutes({ db, tenantDb, clock }));
  api.use(handoverRoutes({ db, tenantDb, clock }));
  api.use(leakageRoutes({ db, tenantDb, clock }));
  api.use(messagingRoutes({ db, tenantDb, clock, messages }));
  api.use(ownerRoutes({ db, clock }));
  api.use(reportRoutes({ db, tenantDb, clock }));
  api.use(platformRoutes({ db, clock, config }));
  api.use(
    paymentIntentRoutes({
      db,
      tenantDb,
      clock,
      provider: payments,
      email,
      logger,
      devPages: config.nodeEnv !== 'production',
    }),
  );
  api.use(webhookRoutes({ db, tenantDb, clock, provider: payments, email, logger }));
  if (routes) api.use(routes);
  app.use('/api/v1', api);

  // 10. Errors → envelope
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
