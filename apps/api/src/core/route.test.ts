import { EXAMPLE_ROUTES } from '@hotel/shared/testing';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { buildTestApp, errorOf } from '../../test/helpers.ts';
import { mountRoute, toExpressPath } from './route.ts';

const FOLIO_ID = '3f2b8a4e-7d9a-4b1c-8d3e-4f5a6b7c8d9e';
const PROPERTY_ID = '0d0d0d0d-0000-4000-8000-000000000002';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const NGN = (amountMinor: string) => ({ amountMinor, currency: 'NGN' });

function appWith(mount: (router: express.Router) => void) {
  const router = express.Router();
  mount(router);
  return buildTestApp(router).app;
}

describe('toExpressPath', () => {
  it('turns OpenAPI parameters into Express parameters', () => {
    expect(toExpressPath('/folios/{folioId}/charges/{chargeId}')).toBe(
      '/folios/:folioId/charges/:chargeId',
    );
  });
});

describe('mountRoute: input', () => {
  it('passes parsed params to the handler and answers with the response schema', async () => {
    const handler = vi.fn(({ params }: { params: { folioId: string } }) => ({
      id: params.folioId,
      number: 'F-1001',
      balance: NGN('4500000'),
    }));
    const app = appWith((r) => mountRoute(r, EXAMPLE_ROUTES.getFolio, handler));
    const res = await request(app)
      .get(`/api/v1/folios/${FOLIO_ID}`)
      .set('X-Property-Id', PROPERTY_ID);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: FOLIO_ID, number: 'F-1001', balance: NGN('4500000') });
    expect(handler.mock.calls[0]?.[0]).toEqual({
      params: { folioId: FOLIO_ID },
      query: {},
      body: undefined,
    });
  });

  it('applies query defaults and coercion', async () => {
    let seen: unknown;
    const app = appWith((r) =>
      mountRoute(r, EXAMPLE_ROUTES.listReservations, ({ query }) => {
        seen = query;
        return { data: [], nextCursor: null };
      }),
    );
    await request(app)
      .get('/api/v1/reservations?status=CONFIRMED')
      .set('X-Property-Id', PROPERTY_ID)
      .expect(200);
    expect(seen).toEqual({ limit: 50, status: 'CONFIRMED' });
  });

  it('reports every problem at once, with where it is', async () => {
    const handler = vi.fn();
    const app = appWith((r) => mountRoute(r, EXAMPLE_ROUTES.postCharge, handler));
    const res = await request(app)
      .post('/api/v1/folios/not-a-uuid/charges')
      .send({ amount: { amountMinor: 4500000, currency: 'NGN' }, description: '' });
    expect(res.status).toBe(400);
    const error = errorOf(res);
    expect(error.code).toBe('VALIDATION_ERROR');
    const paths = (error.details?.['issues'] as { path: string }[]).map((i) => i.path);
    expect(paths).toEqual([
      'headers.X-Property-Id',
      'headers.Idempotency-Key',
      'params.folioId',
      'body.amount.amountMinor',
      'body.description',
    ]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('requires If-Match on versioned PATCHes', async () => {
    const app = appWith((r) =>
      mountRoute(r, EXAMPLE_ROUTES.renameRoom, ({ params, body }) => ({
        id: params.roomId,
        name: body.name,
      })),
    );
    const call = () =>
      request(app)
        .patch(`/api/v1/rooms/${FOLIO_ID}`)
        .set('X-Property-Id', PROPERTY_ID)
        .send({ name: 'Deluxe 101' });
    const missing = await call();
    expect(errorOf(missing).details?.['issues']).toEqual([
      expect.objectContaining({ path: 'headers.If-Match' }),
    ]);
    await call().set('If-Match', '"3"').expect(200, { id: FOLIO_ID, name: 'Deluxe 101' });
  });
});

describe('mountRoute: output', () => {
  it('uses the route status, and sends no body for 204', async () => {
    const app = appWith((r) => {
      mountRoute(r, EXAMPLE_ROUTES.postCharge, ({ body }) => ({
        id: FOLIO_ID,
        amount: body.amount,
      }));
      mountRoute(r, EXAMPLE_ROUTES.deleteNote, () => undefined);
    });
    await request(app)
      .post(`/api/v1/folios/${FOLIO_ID}/charges`)
      .set('X-Property-Id', PROPERTY_ID)
      .set('Idempotency-Key', KEY)
      .send({ amount: NGN('250000'), description: 'Laundry' })
      .expect(201, { id: FOLIO_ID, amount: NGN('250000') });
    const res = await request(app).delete(`/api/v1/notes/${FOLIO_ID}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('strips fields the contract does not list', async () => {
    const app = appWith((r) =>
      mountRoute(r, EXAMPLE_ROUTES.getFolio, () => ({
        id: FOLIO_ID,
        number: 'F-1001',
        balance: NGN('0'),
        internalNote: 'guest disputed minibar',
      })),
    );
    const res = await request(app)
      .get(`/api/v1/folios/${FOLIO_ID}`)
      .set('X-Property-Id', PROPERTY_ID);
    expect(res.body).not.toHaveProperty('internalNote');
  });

  it('treats a response that breaks the contract as a server error', async () => {
    const app = appWith((r) =>
      // Deliberately wrong: amount as a number.
      mountRoute(r, EXAMPLE_ROUTES.getFolio, () => ({
        id: FOLIO_ID,
        number: 'F-1001',
        balance: { amountMinor: 100 as unknown as string, currency: 'NGN' },
      })),
    );
    const res = await request(app)
      .get(`/api/v1/folios/${FOLIO_ID}`)
      .set('X-Property-Id', PROPERTY_ID);
    expect(res.status).toBe(500);
    expect(errorOf(res).code).toBe('INTERNAL');
  });
});
