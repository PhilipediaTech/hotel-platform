import { PAYMENT_INTENT_ROUTES } from '@hotel/shared';
import express, { type Router } from 'express';
import type { FakePaymentProvider } from '../../core/payments.ts';
import { mountRoute } from '../../core/route.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import * as intents from './intents.ts';

/** Property-scoped routes always have a tenant (mountRoute answers 404 otherwise). */
function tenantFrom(tenant: TenantContext | null): TenantContext {
  if (!tenant) throw new Error('Tenant missing on a property-scoped route');
  return tenant;
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Payment links (tab 4 POST /payment-intents ●; T-070). */
export function paymentIntentRoutes(deps: intents.IntentDeps & { devPages: boolean }): Router {
  const router = express.Router();
  const r = PAYMENT_INTENT_ROUTES;

  mountRoute(router, r.createPaymentIntent, ({ body }, { tenant }) =>
    intents.createPaymentIntent(deps, tenantFrom(tenant), body),
  );
  mountRoute(router, r.listPaymentIntents, ({ query }) => intents.listPaymentIntents(deps, query));
  mountRoute(router, r.checkPaymentIntent, ({ params }) =>
    intents.checkPaymentIntent(deps, params.paymentIntentId),
  );

  // Development only, with the fake provider: its "checkout page". Opening the link pays it,
  // as the guest would on the provider's page. Never mounted in production.
  if (deps.devPages && deps.provider.name === 'FAKE') {
    const fake = deps.provider as FakePaymentProvider;
    router.get('/dev/fake-pay/:reference', (req, res) => {
      const reference = String(req.params['reference']);
      const session = fake.sessions.get(reference);
      res.set('Cache-Control', 'no-store').type('html');
      if (!session) {
        res
          .status(404)
          .send(
            '<p>No such payment link (the fake provider forgets links when the API restarts).</p>',
          );
        return;
      }
      if (session.status === 'PENDING') fake.complete(reference);
      const amount = (Number(session.amountMinor) / 100).toFixed(2);
      res.send(
        `<!doctype html><meta charset="utf-8"><title>Paid (fake)</title>` +
          `<p><strong>Paid ${escape(session.currency)} ${amount}</strong> with the fake payment provider.</p>` +
          `<p>Reference ${escape(reference)}. Back in the app, press <em>Check payment</em>, or wait for the next check.</p>`,
      );
    });
  }

  return router;
}
