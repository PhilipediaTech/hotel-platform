import type { EmailMessage } from '../../core/email.ts';

export function invitationMessage(
  to: string,
  details: {
    inviterName: string;
    organisationName: string;
    propertyName: string | null;
    roleName: string;
    link: string;
  },
): EmailMessage {
  const where = details.propertyName
    ? `${details.propertyName} (${details.organisationName})`
    : `every property of ${details.organisationName}`;
  return {
    to,
    tag: 'invitation',
    subject: `${details.inviterName} invited you to ${details.organisationName}`,
    text: [
      `${details.inviterName} invited you to work at ${where} as ${details.roleName}.`,
      '',
      'Accept the invitation here:',
      details.link,
      '',
      'The link works once and expires in 7 days.',
    ].join('\n'),
  };
}
