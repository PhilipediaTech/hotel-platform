# ADR-021: First payment provider: Paystack or Flutterwave

- **Status:** Accepted — Paystack (Philip, 2026-11-02; built in T-070)
- **Source:** Master Specification v3.0, tab 10 (Decision Log)

## Context

Virtual accounts and webhooks are required either way.

## Decision

The first payment provider is **Paystack**, behind the `PaymentProvider` interface in
`apps/api/src/core/payments.ts` (adapter: `core/paystack.ts`). Reasons: strong Nigerian card
and transfer coverage, a Dedicated Virtual Accounts API that fits T-071, HMAC-SHA512 webhook
signatures, and a mature test mode.

## Consequences

- `PAYMENT_PROVIDER=paystack` with `PAYMENT_SECRET_KEY` (a test key, `sk_test_…`, outside
  production; live keys are refused there). `PAYMENT_PROVIDER=fake` locally and in tests; the
  fake is refused in production.
- Payment links are Paystack hosted checkouts (Transaction Initialize) under our own
  reference; a charge is read back with Verify Transaction. Webhooks, virtual accounts and the
  unmatched-transfer queue follow in T-071.
- A second provider (Flutterwave) can be added as another adapter of the same interface.
- See the Architecture and Stack tab (2) for how providers are applied.
