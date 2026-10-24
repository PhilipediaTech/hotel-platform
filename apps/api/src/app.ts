import { getOpenApiDocument } from '@hotel/shared';
import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import type { Config } from './core/config.ts';
import { errorHandler, notFoundHandler } from './core/errors.ts';
import { httpLogger } from './core/logger.ts';
import { openApiDocument } from './core/openapi.ts';
import { requestId } from './core/request-id.ts';
import { mountRoute } from './core/route.ts';

export const BODY_LIMIT = '100kb';

export interface AppOptions {
  config: Config;
  logger: Logger;
  /** Mounted under /api/v1. Modules register here as they are built. */
  routes?: Router;
}

/** Middleware order follows spec tab 2, "Request lifecycle". */
export function createApp({ config, logger, routes }: AppOptions): Express {
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
  // 5. Session load (T-010)  6. CSRF Origin check (T-010)
  // 7. Tenancy context (T-012)  8. Rate limiter (T-010)

  // 9. Routes
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  const api = express.Router();
  // Spread: the generator types the document as an interface, which lacks an index signature.
  mountRoute(api, getOpenApiDocument, () => ({ ...openApiDocument() }));
  if (routes) api.use(routes);
  app.use('/api/v1', api);

  // 10. Errors → envelope
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
