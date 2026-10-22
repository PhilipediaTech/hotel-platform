import { randomUUID } from 'node:crypto';
import type { Request, RequestHandler } from 'express';

/** Accept a caller's X-Request-Id only if it is short and log-safe; otherwise mint one. */
const INCOMING_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function requestId(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const id =
      incoming !== undefined && INCOMING_ID.test(incoming)
        ? incoming
        : `req_${randomUUID().replaceAll('-', '')}`;
    req.id = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

export function getRequestId(req: Request): string {
  // pino-http types req.id as string | number | object; requestId() always sets a string.
  return typeof req.id === 'string' ? req.id : 'req_unknown';
}
