import type { IncomingMessage, ServerResponse } from 'node:http';
import { pino, type DestinationStream, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import type { Request } from 'express';
import { getAuth } from './auth.ts';
import type { Config } from './config.ts';
import { tenantOf } from './tenancy.ts';

export const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.pin',
  '*.otp',
  '*.token',
];

/** JSON logs in every environment except local development, which pretty-prints. */
export function createLogger(config: Config, destination?: DestinationStream): Logger {
  const options = {
    level: config.logLevel,
    base: { service: 'api' },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  };
  if (destination) return pino(options, destination);
  if (config.nodeEnv === 'development') {
    return pino({ ...options, transport: { target: 'pino-pretty' } });
  }
  return pino(options);
}

/** Who and where, for request logs; empty until sign-in (step 5) and tenancy (step 7) ran. */
function requestBindings(req: Request): Record<string, string> {
  const auth = getAuth(req);
  const tenant = tenantOf(req);
  return {
    ...(auth ? { userId: auth.user.id } : {}),
    ...(tenant ? { orgId: tenant.organisationId, propertyId: tenant.propertyId } : {}),
  };
}

export function httpLogger(logger: Logger) {
  return pinoHttp({
    logger,
    // requestId() runs first and has already set req.id.
    genReqId: (req: IncomingMessage) => req.id,
    autoLogging: { ignore: (req: IncomingMessage) => req.url === '/health' },
    // Keep request logs small and free of headers (cookies, tokens, guest data).
    serializers: {
      req: (req: { id: unknown; method: string; url: string; remoteAddress?: string }) => ({
        id: req.id,
        method: req.method,
        url: req.url,
        remoteAddress: req.remoteAddress,
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
    // Tab 2: request logs carry orgId, propertyId and userId once they are known.
    customProps: (req: IncomingMessage) => requestBindings(req as Request),
    customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => {
      if (err !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  });
}
