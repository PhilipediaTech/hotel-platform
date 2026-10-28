import { ERROR_HTTP_STATUS, type ErrorCode, type ErrorEnvelope } from '@hotel/shared';
import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
// req.id and req.log are declared by pino-http (also for programs that don't load logger.ts).
import type {} from 'pino-http';
import { getRequestId } from './request-id.ts';

/** Throw this from services and routes; the error handler turns it into the envelope. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

const INTERNAL_MESSAGE = 'Something went wrong. Quote the request ID when contacting support.';

/** Errors thrown by express.json() (body-parser) carry a `type` and an HTTP `status`. */
interface BodyParserError {
  type: string;
  status: number;
  limit?: number;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { type?: unknown }).type === 'string' &&
    typeof (err as { status?: unknown }).status === 'number'
  );
}

function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new AppError('VALIDATION_ERROR', 'Request validation failed.', {
      issues: err.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  if (isBodyParserError(err) && err.status >= 400 && err.status < 500) {
    if (err.type === 'entity.parse.failed') {
      return new AppError('VALIDATION_ERROR', 'Request body is not valid JSON.');
    }
    if (err.type === 'entity.too.large') {
      return new AppError('VALIDATION_ERROR', 'Request body is too large.', {
        limitBytes: err.limit,
      });
    }
    return new AppError('VALIDATION_ERROR', 'Request body could not be read.', {
      reason: err.type,
    });
  }

  return undefined;
}

function send(res: Response, status: number, body: ErrorEnvelope): void {
  res.status(status).json(body);
}

export const notFoundHandler: RequestHandler = () => {
  throw new AppError('NOT_FOUND', 'Route not found.');
};

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const requestId = getRequestId(req);
  const appError = toAppError(err);

  if (appError) {
    const body: ErrorEnvelope = {
      error: { code: appError.code, message: appError.message, requestId },
    };
    if (appError.details !== undefined) body.error.details = appError.details;
    send(res, appError.status, body);
    return;
  }

  req.log.error({ err }, 'Unhandled error');
  send(res, 500, { error: { code: 'INTERNAL', message: INTERNAL_MESSAGE, requestId } });
};
