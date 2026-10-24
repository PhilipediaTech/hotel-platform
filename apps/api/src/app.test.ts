import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from './core/errors.ts';
import { APP_ORIGIN, buildTestApp, errorOf, TEST_CONFIG } from '../test/helpers.ts';

function routesThatFail() {
  const router = express.Router();
  router.get('/boom/app-error', () => {
    throw new AppError('BOOKING_CONFLICT', 'No Deluxe rooms left for 12 Nov 2026.', {
      date: '2026-11-12',
    });
  });
  router.get('/boom/async', async () => {
    await Promise.resolve();
    throw new AppError('SHIFT_NOT_OPEN', 'Open a shift first.');
  });
  router.get('/boom/zod', () => {
    z.object({ arrival: z.iso.date() }).parse({ arrival: '12/11/2026' });
  });
  router.get('/boom/unexpected', () => {
    throw new Error('connection string postgres://secret@db leaked?');
  });
  router.post('/echo', (req, res) => {
    res.status(201).json({ received: req.body as unknown });
  });
  return router;
}

const REQUEST_ID = /^req_[0-9a-f]{32}$/;

describe('GET /health', () => {
  it('returns 200 { status: "ok" } as JSON', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('is not logged (Render polls it constantly)', async () => {
    const { app, logLines } = buildTestApp();
    await request(app).get('/health');
    expect(logLines.filter((l) => l.msg === 'request completed')).toHaveLength(0);
  });
});

describe('request ID', () => {
  it('mints a req_ id and returns it in X-Request-Id', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health');
    expect(res.headers['x-request-id']).toMatch(REQUEST_ID);
  });

  it('gives each request its own id', async () => {
    const { app } = buildTestApp();
    const a = await request(app).get('/health');
    const b = await request(app).get('/health');
    expect(a.headers['x-request-id']).not.toBe(b.headers['x-request-id']);
  });

  it('keeps a well-formed incoming X-Request-Id', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health').set('X-Request-Id', 'web_client-1234');
    expect(res.headers['x-request-id']).toBe('web_client-1234');
  });

  it.each(['short', 'has spaces in it', 'x'.repeat(65), '"><script>', 'a;b=c,d/e'])(
    'replaces an unsafe incoming id %j',
    async (incoming) => {
      const { app } = buildTestApp();
      const res = await request(app).get('/health').set('X-Request-Id', incoming);
      expect(res.headers['x-request-id']).toMatch(REQUEST_ID);
    },
  );

  it('appears in the request log line', async () => {
    const { app, logLines } = buildTestApp();
    const res = await request(app).get('/api/v1/missing');
    const line = logLines.find((l) => l.msg === 'request completed');
    expect(line).toMatchObject({
      req: { id: res.headers['x-request-id'], method: 'GET', url: '/api/v1/missing' },
      res: { statusCode: 404 },
    });
  });
});

describe('request logging', () => {
  it('never logs cookies or authorization headers', async () => {
    const { app, logLines } = buildTestApp();
    await request(app)
      .get('/api/v1/missing')
      .set('Cookie', 'sid=super-secret-session')
      .set('Authorization', 'Bearer super-secret-token');
    expect(JSON.stringify(logLines)).not.toContain('super-secret');
  });

  it('redacts secret-looking fields in logged objects', () => {
    const { logger, logLines } = buildTestApp();
    logger.info({ body: { password: 'hunter2', pin: '123456', otp: '482913', name: 'Ada' } }, 'x');
    expect(logLines[0]).toMatchObject({
      body: { password: '[REDACTED]', pin: '[REDACTED]', otp: '[REDACTED]', name: 'Ada' },
    });
  });
});

describe('security headers', () => {
  it('sets helmet headers and hides the framework', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CORS allow-list', () => {
  it.each([TEST_CONFIG.appOrigin, TEST_CONFIG.siteOrigin])(
    'allows %s with credentials',
    async (origin) => {
      const { app } = buildTestApp();
      const res = await request(app).get('/health').set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-expose-headers']).toContain('X-Request-Id');
    },
  );

  it('does not allow any other origin', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/health').set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight from an allowed origin', async () => {
    const { app } = buildTestApp();
    const res = await request(app)
      .options('/api/v1/reservations')
      .set('Origin', TEST_CONFIG.appOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,idempotency-key,x-property-id');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(TEST_CONFIG.appOrigin);
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });
});

describe('error envelope', () => {
  it('returns NOT_FOUND for an unknown route, with the request ID', async () => {
    const { app } = buildTestApp();
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found.',
        requestId: res.headers['x-request-id'],
      },
    });
  });

  it('maps an AppError to its status, code, message and details', async () => {
    const { app } = buildTestApp(routesThatFail());
    const res = await request(app).get('/api/v1/boom/app-error');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'BOOKING_CONFLICT',
        message: 'No Deluxe rooms left for 12 Nov 2026.',
        details: { date: '2026-11-12' },
        requestId: res.headers['x-request-id'],
      },
    });
  });

  it('catches errors thrown by async handlers (Express 5)', async () => {
    const { app } = buildTestApp(routesThatFail());
    const res = await request(app).get('/api/v1/boom/async');
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe('SHIFT_NOT_OPEN');
  });

  it('turns a Zod error into VALIDATION_ERROR with field issues', async () => {
    const { app } = buildTestApp(routesThatFail());
    const res = await request(app).get('/api/v1/boom/zod');
    expect(res.status).toBe(400);
    const error = errorOf(res);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details?.issues).toEqual([
      { path: 'arrival', code: 'invalid_format', message: 'Invalid ISO date' },
    ]);
  });

  it('hides unexpected errors behind INTERNAL and logs them', async () => {
    const { app, logLines } = buildTestApp(routesThatFail());
    const res = await request(app).get('/api/v1/boom/unexpected');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong. Quote the request ID when contacting support.',
        requestId: res.headers['x-request-id'],
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('postgres://');
    const logged = logLines.find((l) => l.msg === 'Unhandled error');
    expect(logged?.level).toBe(50);
    expect((logged?.err as { message: string }).message).toContain('leaked');
  });
});

describe('JSON body parser', () => {
  it('parses a JSON body', async () => {
    const { app } = buildTestApp(routesThatFail());
    const res = await request(app)
      .post('/api/v1/echo')
      .set('Origin', APP_ORIGIN)
      .send({ adults: 2 });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ received: { adults: 2 } });
  });

  it('rejects malformed JSON as VALIDATION_ERROR', async () => {
    const { app } = buildTestApp(routesThatFail());
    const res = await request(app)
      .post('/api/v1/echo')
      .set('Content-Type', 'application/json')
      .send('{"adults": 2,');
    expect(res.status).toBe(400);
    expect(errorOf(res)).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request body is not valid JSON.',
    });
  });

  it('rejects a body over 100 kB as VALIDATION_ERROR', async () => {
    const { app } = buildTestApp(routesThatFail());
    const res = await request(app)
      .post('/api/v1/echo')
      .send({ notes: 'x'.repeat(101 * 1024) });
    expect(res.status).toBe(400);
    expect(errorOf(res)).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Request body is too large.',
      details: { limitBytes: 102_400 },
    });
  });
});
