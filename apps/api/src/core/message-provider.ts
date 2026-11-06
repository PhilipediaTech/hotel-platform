import type { Logger } from 'pino';
import type { Config } from './config.ts';
import { createFakeMessageProvider, type MessageProvider } from './messaging.ts';
import { createMetaWhatsAppProvider } from './meta-whatsapp.ts';

/** The WhatsApp provider the configuration names (WHATSAPP_PROVIDER; ADR-016). */
export function createMessageProvider(config: Config, logger: Logger): MessageProvider {
  const w = config.whatsapp;
  if (w.provider === 'meta') {
    return createMetaWhatsAppProvider({
      token: w.token ?? '',
      phoneNumberId: w.phoneNumberId ?? '',
      businessAccountId: w.businessAccountId,
      appSecret: w.appSecret,
      verifyToken: w.verifyToken,
      graphVersion: w.graphVersion,
    });
  }
  // Local development: messages are logged, so codes can be read from the terminal.
  return createFakeMessageProvider(logger);
}
