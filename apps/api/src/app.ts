import { getOpenApiDocument } from '@hotel/shared';
import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { sessionLoader } from './core/auth.ts';
import { systemClock, type Clock } from './core/clock.ts';
import type { Config } from './core/config.ts';
import { originCheck } from './core/csrf.ts';
import type { Db } from './core/db.ts';
import type { EmailProvider } from './core/email.ts';
import { errorHandler, notFoundHandler } from './core/errors.ts';
import { httpLogger } from './core/logger.ts';
import { openApiDocument } from './core/openapi.ts';
import { rateLimiter } from './core/rate-limit.ts';
import { createTenantDb } from './core/tenant-db.ts';
import { tenancyContext } from './core/tenancy.ts';
import { requestId } from './core/request-id.ts';
import { mountRoute } from './core/route.ts';
import { accessRoutes } from './modules/access/routes.ts';
import { identityRoutes } from './modules/identity/routes.ts';

export const BODY_LIMIT = '100kb';

export interface AppOptions {
  config: Config;
  logger: Logger;
  db: Db;
  email: EmailProvider;
  clock?: Clock;
  /** Extra routes mounted under /api/v1 after the modules (tests use this). */
  routes?: Router;
}

/** Middleware order follows spec tab 2, "Request lifecycle". */
export function createApp({
  config,
  logger,
  db,
  email,
  clock = systemClock,
  routes,
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
  // 4. Body parser with size limit
  app.use(express.json({ limit: BODY_LIMIT }));
  // 5. Session load (cookie → sessions row)
  app.use(sessionLoader({ db, config, clock }));
  // 6. CSRF: Origin must be allow-listed on every non-GET
  app.use(originCheck(config));
  // 7. Tenancy context: X-Property-Id → membership → AsyncLocalStorage
  app.use(tenancyContext({ db }));
  // 8. Rate limiter (per IP on auth routes, per user)
  app.use(rateLimiter({ db, clock, logger }));

  // 9. Routes
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  const api = express.Router();
  // Spread: the generator types the document as an interface, which lacks an index signature.
  mountRoute(api, getOpenApiDocument, () => ({ ...openApiDocument() }));
  api.use(identityRoutes({ db, config, clock, email, logger }));
  // Module code reads and writes tenant tables through the tenant-scoped client (T-012).
  const tenantDb = createTenantDb(db);
  api.use(accessRoutes({ db, tenantDb, config, clock, email, logger }));
  if (routes) api.use(routes);
  app.use('/api/v1', api);

  // 10. Errors → envelope
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
