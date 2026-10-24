import type { EmailMessage } from '../../core/email.ts';

// Plain-text account emails. English only for now; localised templates arrive with the
// messaging module (M8 / T-024).

export function verifyEmailMessage(to: string, name: string, link: string): EmailMessage {
  return {
    to,
    tag: 'verify-email',
    subject: 'Confirm your email address',
    text: [
      `Hello ${name},`,
      '',
      'Confirm your email address to finish creating your hotel account:',
      link,
      '',
      'The link works once and expires in 24 hours. If you did not sign up, ignore this email.',
    ].join('\n'),
  };
}

export function accountExistsMessage(
  to: string,
  signInLink: string,
  resetLink: string,
): EmailMessage {
  return {
    to,
    tag: 'account-exists',
    subject: 'You already have an account',
    text: [
      'Someone tried to sign up with this email address, which already has an account.',
      '',
      `Sign in: ${signInLink}`,
      `Forgot your password? ${resetLink}`,
      '',
      'If this was not you, no action is needed.',
    ].join('\n'),
  };
}

export function passwordResetMessage(to: string, name: string, link: string): EmailMessage {
  return {
    to,
    tag: 'password-reset',
    subject: 'Reset your password',
    text: [
      `Hello ${name},`,
      '',
      'Use this link to choose a new password:',
      link,
      '',
      'The link works once and expires in 1 hour. Resetting signs you out on every device.',
      'If you did not ask for this, ignore this email; your password stays the same.',
    ].join('\n'),
  };
}
