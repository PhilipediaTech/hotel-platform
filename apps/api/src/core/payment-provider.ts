import type { Logger } from 'pino';
import type { Config } from './config.ts';
import { createFakePaymentProvider, type PaymentProvider } from './payments.ts';
import { createPaystackProvider } from './paystack.ts';

/** The payment provider the configuration names (PAYMENT_PROVIDER; ADR-021). */
export function createPaymentProvider(config: Config, logger: Logger): PaymentProvider {
  if (config.payments.provider === 'paystack') {
    return createPaystackProvider({ secretKey: config.payments.secretKey ?? '' });
  }
  // Its links open the API's development page through the web app's /api proxy.
  return createFakePaymentProvider({
    checkoutBase: `${config.appOrigin}/api/v1/dev/fake-pay`,
    logger,
  });
}
