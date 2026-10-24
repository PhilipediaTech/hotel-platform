import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { IsoDate, Money, PageQuery, Uuid, page } from './primitives.ts';

// Example contracts covering every route feature, for tests of the server mounting, the
// OpenAPI generator and the web client. Imported as `@hotel/shared/testing`; never part of
// API_ROUTES.

const Folio = z.object({ id: Uuid, number: z.string(), balance: Money });

export const EXAMPLE_ROUTES = {
  getFolio: defineRoute({
    operationId: 'getFolio',
    method: 'get',
    path: '/folios/{folioId}',
    summary: 'Get a folio',
    tags: ['Folios'],
    propertyScoped: true,
    permission: 'folio.read',
    params: z.object({ folioId: Uuid }),
    response: Folio,
  }),
  listReservations: defineRoute({
    operationId: 'listReservations',
    method: 'get',
    path: '/reservations',
    summary: 'List reservations',
    tags: ['Reservations'],
    propertyScoped: true,
    query: PageQuery.extend({
      status: z.enum(['CONFIRMED', 'CANCELLED']).optional(),
      arrivalFrom: IsoDate.optional(),
    }),
    response: page(z.object({ id: Uuid, arrival: IsoDate })),
  }),
  postCharge: defineRoute({
    operationId: 'postCharge',
    method: 'post',
    path: '/folios/{folioId}/charges',
    summary: 'Post a charge',
    tags: ['Folios'],
    propertyScoped: true,
    permission: 'folio.post',
    idempotent: true,
    approval: true,
    params: z.object({ folioId: Uuid }),
    body: z.object({ amount: Money, description: z.string().min(1).max(200) }),
    status: 201,
    response: z.object({ id: Uuid, amount: Money }),
    errors: ['BUSINESS_DAY_CLOSED', 'SHIFT_NOT_OPEN'],
  }),
  renameRoom: defineRoute({
    operationId: 'renameRoom',
    method: 'patch',
    path: '/rooms/{roomId}',
    summary: 'Rename a room',
    tags: ['Rooms'],
    propertyScoped: true,
    ifMatch: true,
    params: z.object({ roomId: Uuid }),
    body: z.object({ name: z.string().min(1) }),
    response: z.object({ id: Uuid, name: z.string() }),
  }),
  deleteNote: defineRoute({
    operationId: 'deleteNote',
    method: 'delete',
    path: '/notes/{noteId}',
    summary: 'Delete a note',
    tags: ['Notes'],
    params: z.object({ noteId: Uuid }),
    status: 204,
    response: z.void(),
  }),
} as const;
