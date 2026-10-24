import type { Logger } from 'pino';

// EmailProvider interface (spec tab 2, "Integrations"): Amazon SES in production, behind
// this interface; the fake is used in tests and local development.

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Short machine name for logs and metrics, e.g. `verify-email`. */
  tag: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}

export interface FakeEmailProvider extends EmailProvider {
  readonly sent: EmailMessage[];
  /** Most recent message to `to`, if any. */
  lastTo(to: string): EmailMessage | undefined;
}

/**
 * Keeps messages in memory. With a logger (local development) it also logs each message
 * so links can be opened from the terminal; never use it in production.
 */
export function createFakeEmailProvider(logger?: Logger): FakeEmailProvider {
  const sent: EmailMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
      logger?.info({ email: message }, `Email (not sent, fake provider): ${message.subject}`);
      return Promise.resolve();
    },
    lastTo(to) {
      return sent.findLast((m) => m.to === to);
    },
  };
}
