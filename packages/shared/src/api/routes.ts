import { z } from 'zod';
import { ACCESS_ROUTES } from './access.ts';
import { APPROVAL_ROUTES } from './approvals.ts';
import { AUDIT_ROUTES } from './audit.ts';
import { AUTH_ROUTES } from './auth.ts';
import { defineRoute } from './contract.ts';
import { FILE_ROUTES } from './files.ts';
import { FOLIO_ROUTES } from './folios.ts';
import { FRONT_DESK_ROUTES } from './front-desk.ts';
import { FX_ROUTES } from './fx.ts';
import { GUEST_ROUTES } from './guests.ts';
import { HANDOVER_ROUTES } from './handovers.ts';
import { LEAKAGE_ROUTES } from './leakage.ts';
import { MESSAGE_ROUTES } from './messages.ts';
import { OWNER_ROUTES } from './owner.ts';
import { BOOKING_ENGINE_ROUTES } from './booking-engine.ts';
import { INBOX_ROUTES } from './inbox.ts';
import { EVENT_ROUTES } from './events.ts';
import { EVENT_SALES_ROUTES } from './event-sales.ts';
import { EVENT_CLOSEOUT_ROUTES } from './event-closeout.ts';
import { EVENT_CANCELLATION_ROUTES } from './event-cancellation.ts';
import { SERVICE_ROUTES } from './services.ts';
import { GROUP_BLOCK_ROUTES } from './group-blocks.ts';
import { AR_ROUTES } from './ar.ts';
import { COMMISSION_ROUTES } from './commissions.ts';
import { PARTNER_ROUTES } from './partners.ts';
import { PLATFORM_ROUTES } from './platform.ts';
import { REPORT_ROUTES } from './reports.ts';
import { HOUSEKEEPING_ROUTES } from './housekeeping.ts';
import { IMPORT_ROUTES } from './imports.ts';
import { INVENTORY_ROUTES } from './inventory.ts';
import { NIGHT_AUDIT_ROUTES } from './night-audit.ts';
import { PAYMENT_INTENT_ROUTES } from './payment-intents.ts';
import { PAYMENT_ROUTES } from './payments.ts';
import { QUOTE_ROUTES } from './quotes.ts';
import { PROPERTY_ROUTES } from './properties.ts';
import { RATE_ROUTES } from './rates.ts';
import { OCCUPANT_ROUTES } from './occupants.ts';
import { VISITOR_ROUTES } from './visitors.ts';
import { RESERVATION_ROUTES } from './reservations.ts';
import { ROOM_ROUTES } from './rooms.ts';
import { SHIFT_ROUTES } from './shifts.ts';
import { TASK_ROUTES } from './tasks.ts';
import { TAX_ROUTES } from './tax.ts';
import { VIRTUAL_ACCOUNT_ROUTES } from './virtual-accounts.ts';

// The API surface, one entry per endpoint in spec tab 4. Modules add their routes here as
// they are built; `npm run openapi` regenerates apps/api/openapi.json from this list.

export const getOpenApiDocument = defineRoute({
  operationId: 'getOpenApiDocument',
  method: 'get',
  path: '/openapi.json',
  summary: 'This API description (OpenAPI 3.1)',
  tags: ['Meta'],
  auth: 'none',
  response: z.record(z.string(), z.unknown()).meta({ description: 'OpenAPI 3.1 document' }),
});

export const API_ROUTES = {
  getOpenApiDocument,
  ...PARTNER_ROUTES,
  ...INBOX_ROUTES,
  ...EVENT_ROUTES,
  ...EVENT_SALES_ROUTES,
  ...EVENT_CLOSEOUT_ROUTES,
  ...EVENT_CANCELLATION_ROUTES,
  ...SERVICE_ROUTES,
  ...GROUP_BLOCK_ROUTES,
  ...AR_ROUTES,
  ...COMMISSION_ROUTES,
  ...BOOKING_ENGINE_ROUTES,
  ...AUTH_ROUTES,
  ...ACCESS_ROUTES,
  ...AUDIT_ROUTES,
  ...APPROVAL_ROUTES,
  ...FILE_ROUTES,
  ...PROPERTY_ROUTES,
  ...ROOM_ROUTES,
  ...TAX_ROUTES,
  ...RATE_ROUTES,
  ...IMPORT_ROUTES,
  ...INVENTORY_ROUTES,
  ...QUOTE_ROUTES,
  ...GUEST_ROUTES,
  ...RESERVATION_ROUTES,
  ...OCCUPANT_ROUTES,
  ...VISITOR_ROUTES,
  ...FRONT_DESK_ROUTES,
  ...NIGHT_AUDIT_ROUTES,
  ...FOLIO_ROUTES,
  ...SHIFT_ROUTES,
  ...PAYMENT_ROUTES,
  ...PAYMENT_INTENT_ROUTES,
  ...VIRTUAL_ACCOUNT_ROUTES,
  ...HOUSEKEEPING_ROUTES,
  ...TASK_ROUTES,
  ...HANDOVER_ROUTES,
  ...LEAKAGE_ROUTES,
  ...MESSAGE_ROUTES,
  ...OWNER_ROUTES,
  ...PLATFORM_ROUTES,
  ...REPORT_ROUTES,
  ...FX_ROUTES,
} as const;

export type ApiRoutes = typeof API_ROUTES;
export type OperationId = keyof ApiRoutes;
