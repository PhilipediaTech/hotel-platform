// Message templates (PRD M11-05, M11 rules; tab 3 `message_templates`; T-024). The default
// wording of every message lives here. An organisation may change the email wording per
// language (a `message_templates` row); WhatsApp wording is the platform's, because WhatsApp
// sends only templates Meta has approved (M11 rule "only approved templates outside the
// 24-hour window"), and each change needs approval again.
//
// Text uses named placeholders, `{{guest_name}}`. WhatsApp templates are numbered: the
// placeholders become {{1}}, {{2}}, ... in the order they first appear.

export const MESSAGE_CHANNELS = ['EMAIL', 'WHATSAPP', 'SMS'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

/** Channels with a provider in V1 (SMS has none yet). */
export const SENDING_CHANNELS = ['EMAIL', 'WHATSAPP'] as const;
export type SendingChannel = (typeof SENDING_CHANNELS)[number];

export const MESSAGE_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'French' },
  { code: 'ha', label: 'Hausa' },
  { code: 'ig', label: 'Igbo' },
  { code: 'yo', label: 'Yoruba' },
] as const;
export type MessageLanguage = (typeof MESSAGE_LANGUAGES)[number]['code'];
export const MESSAGE_LANGUAGE_CODES = MESSAGE_LANGUAGES.map((l) => l.code) as [
  MessageLanguage,
  ...MessageLanguage[],
];
export const DEFAULT_MESSAGE_LANGUAGE: MessageLanguage = 'en';

export const DELIVERY_STATUSES = ['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Meta's template categories; AUTHENTICATION carries one-time codes only. */
export type WhatsAppCategory = 'AUTHENTICATION' | 'UTILITY' | 'MARKETING';

export interface TemplateVariable {
  name: string;
  label: string;
  /** Sample value: shown in previews, sent with test messages and to Meta for approval. */
  example: string;
}

export interface MessageTemplateDef {
  code: MessageTemplateCode;
  label: string;
  audience: 'GUEST' | 'STAFF';
  variables: readonly TemplateVariable[];
  email?: { subject: string; body: string };
  whatsapp?: {
    /** The template's name in the WhatsApp Business account. */
    name: string;
    category: WhatsAppCategory;
    /** For AUTHENTICATION, Meta's fixed wording (it is not submitted). */
    body: string;
  };
}

const v = (name: string, label: string, example: string): TemplateVariable => ({
  name,
  label,
  example,
});

const GUEST = v('guest_name', 'Guest name', 'Ada Okafor');
const PROPERTY = v('property_name', 'Hotel name', 'Demo Lagos Hotel');

export const MESSAGE_TEMPLATES: readonly MessageTemplateDef[] = [
  {
    code: 'BOOKING_CONFIRMED',
    label: 'Booking confirmation',
    audience: 'GUEST',
    variables: [
      GUEST,
      PROPERTY,
      v('confirmation_no', 'Confirmation number', 'LAG-10234'),
      v('arrival', 'Arrival date', '12 Dec 2026'),
      v('departure', 'Departure date', '15 Dec 2026'),
      v('room_type', 'Room type', 'Deluxe King'),
      v('total', 'Total', '₦135,000.00'),
    ],
    email: {
      subject: 'Your booking at {{property_name}}: {{confirmation_no}}',
      body:
        'Dear {{guest_name}},\n\nThank you for booking with {{property_name}}. Your confirmation ' +
        'number is {{confirmation_no}}.\n\nArrival: {{arrival}}\nDeparture: {{departure}}\n' +
        'Room: {{room_type}}\nTotal: {{total}}\n\nWe look forward to welcoming you.',
    },
    whatsapp: {
      name: 'booking_confirmed',
      category: 'UTILITY',
      body:
        'Hello {{guest_name}}, your booking at {{property_name}} is confirmed. Confirmation ' +
        'number {{confirmation_no}}, arriving {{arrival}} and leaving {{departure}}. We look ' +
        'forward to welcoming you.',
    },
  },
  {
    code: 'PRE_ARRIVAL',
    label: 'Before arrival',
    audience: 'GUEST',
    variables: [
      GUEST,
      PROPERTY,
      v('arrival', 'Arrival date', '12 Dec 2026'),
      v('check_in_time', 'Check-in time', '14:00'),
      v('property_phone', 'Hotel phone', '+234 800 000 0001'),
    ],
    email: {
      subject: 'See you soon at {{property_name}}',
      body:
        'Dear {{guest_name}},\n\nWe look forward to seeing you at {{property_name}} on ' +
        '{{arrival}}. Check-in is from {{check_in_time}}.\n\nFor anything before you arrive, ' +
        'call us on {{property_phone}}.\n\nSafe travels.',
    },
    whatsapp: {
      name: 'pre_arrival',
      category: 'UTILITY',
      body:
        'Hello {{guest_name}}, we look forward to seeing you at {{property_name}} on ' +
        '{{arrival}}. Check-in is from {{check_in_time}}. For anything before you arrive, call ' +
        'us on {{property_phone}}. Safe travels.',
    },
  },
  {
    code: 'PAYMENT_REQUEST',
    label: 'Payment request',
    audience: 'GUEST',
    variables: [
      GUEST,
      PROPERTY,
      v('amount', 'Amount', '₦45,000.00'),
      v('purpose', 'What it is for', 'booking LAG-10234'),
      v('link', 'Payment link', 'https://pay.example.com/abc123'),
    ],
    email: {
      subject: 'Payment request from {{property_name}}',
      body:
        'Dear {{guest_name}},\n\n{{property_name}} has sent you a payment request of ' +
        '{{amount}} for {{purpose}}.\n\nPay securely here: {{link}}\n\nThank you.',
    },
    whatsapp: {
      name: 'payment_request',
      category: 'UTILITY',
      body:
        'Hello {{guest_name}}, {{property_name}} has sent you a payment request of {{amount}} ' +
        'for {{purpose}}. Pay securely here: {{link}} Thank you.',
    },
  },
  {
    code: 'FOLIO',
    label: 'Bill (folio)',
    audience: 'GUEST',
    variables: [
      GUEST,
      PROPERTY,
      v('folio_no', 'Bill number', 'F-000123'),
      v('total', 'Total', '₦152,500.00'),
      v('link', 'Link to the bill', 'https://app.example.com/f/abc123'),
    ],
    email: {
      subject: 'Your bill from {{property_name}}: {{folio_no}}',
      body:
        'Dear {{guest_name}},\n\nThank you for staying at {{property_name}}. Your bill ' +
        '{{folio_no}} comes to {{total}}.\n\nView and download it here: {{link}}\n\nWe hope to ' +
        'see you again.',
    },
    whatsapp: {
      name: 'folio_ready',
      category: 'UTILITY',
      body:
        'Hello {{guest_name}}, thank you for staying at {{property_name}}. Your bill ' +
        '{{folio_no}} comes to {{total}}. You can view and download it here: {{link}} We hope ' +
        'to see you again.',
    },
  },
  {
    code: 'FEEDBACK',
    label: 'Feedback request',
    audience: 'GUEST',
    variables: [GUEST, PROPERTY, v('link', 'Feedback link', 'https://app.example.com/r/abc123')],
    email: {
      subject: 'How was your stay at {{property_name}}?',
      body:
        'Dear {{guest_name}},\n\nThank you for staying at {{property_name}}. How was your ' +
        'stay? Tell us in one minute here: {{link}}\n\nYour feedback helps us improve.',
    },
    whatsapp: {
      name: 'stay_feedback',
      // A survey is not about a transaction: Meta counts it as marketing.
      category: 'MARKETING',
      body:
        'Hello {{guest_name}}, thank you for staying at {{property_name}}. How was your stay? ' +
        'Tell us in one minute here: {{link}} Your feedback helps us improve.',
    },
  },
  {
    code: 'APPROVAL_OTP',
    label: 'Approval code',
    audience: 'STAFF',
    variables: [v('code', 'One-time code', '482913')],
    whatsapp: {
      name: 'approval_code',
      category: 'AUTHENTICATION',
      body: '{{code}} is your verification code. For your security, do not share this code.',
    },
  },
  {
    code: 'LEAKAGE_ALERT',
    label: 'Leakage alert',
    audience: 'STAFF',
    variables: [
      PROPERTY,
      v('rule', 'Rule', 'Void/reversal pattern'),
      v('detail', 'What happened', '4 reversals totalling ₦62,000.00 by Demo Front Desk.'),
      v('raised_at', 'When', '10 Nov 2026, 22:14'),
    ],
    whatsapp: {
      name: 'leakage_alert',
      category: 'UTILITY',
      body:
        'Leakage alert at {{property_name}}: {{rule}}. {{detail}} Raised {{raised_at}}. Open ' +
        'the app to review it.',
    },
  },
  {
    code: 'FLASH_REPORT',
    label: 'Flash report',
    audience: 'STAFF',
    variables: [
      PROPERTY,
      v('business_date', 'Business day', '10 Nov 2026'),
      v('occupancy', 'Occupancy', '72%'),
      v('rooms_sold', 'Rooms sold', '36'),
      v('room_revenue', 'Room revenue', '₦1,620,000.00'),
      v('adr', 'ADR', '₦45,000.00'),
      v('revpar', 'RevPAR', '₦32,400.00'),
      v('payments', 'Payments taken', '₦1,480,000.00'),
      v('open_alerts', 'Open leakage alerts', '2'),
    ],
    whatsapp: {
      name: 'flash_report',
      category: 'UTILITY',
      body:
        'Flash report for {{property_name}}, {{business_date}}. Occupancy {{occupancy}} ' +
        '({{rooms_sold}} rooms sold). Room revenue {{room_revenue}}, ADR {{adr}}, RevPAR ' +
        '{{revpar}}. Payments taken {{payments}}. Open leakage alerts: {{open_alerts}}. Full ' +
        'report in the app.',
    },
  },
  {
    // T-055 (PRD M14-01): a late check-out, a departure due soon, an expiring hold or a
    // missing deposit, to holders of frontdesk.alerts.notify for the kinds the hotel chose.
    code: 'STAY_ALERT',
    label: 'Front desk alert',
    audience: 'STAFF',
    variables: [
      PROPERTY,
      v('alert', 'Alert', 'Late check-out'),
      v('detail', 'Details', 'Room 204, Ada Obi (LAG-000123): check-out was due at 12:00.'),
    ],
    whatsapp: {
      name: 'stay_alert',
      category: 'UTILITY',
      body: 'Front desk alert at {{property_name}}: {{alert}}. {{detail}} Open the app to act on it.',
    },
  },
];

/**
 * The codes on their own, so the API contract (in every bundle) does not carry the wording
 * above. A test keeps it in step with MESSAGE_TEMPLATES.
 */
export const MESSAGE_TEMPLATE_CODES = [
  'BOOKING_CONFIRMED',
  'PRE_ARRIVAL',
  'PAYMENT_REQUEST',
  'FOLIO',
  'FEEDBACK',
  'APPROVAL_OTP',
  'LEAKAGE_ALERT',
  'FLASH_REPORT',
  'STAY_ALERT',
] as const;
export type MessageTemplateCode = (typeof MESSAGE_TEMPLATE_CODES)[number];

export function messageTemplateDef(code: string): MessageTemplateDef | undefined {
  return MESSAGE_TEMPLATES.find((t) => t.code === code);
}

const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/g;

/** Placeholder names in the order they first appear. */
export function placeholdersOf(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) {
    const name = m[1] ?? '';
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Placeholders the template does not define (an edited text may only use its variables). */
export function unknownPlaceholders(def: MessageTemplateDef, text: string): string[] {
  const known = new Set(def.variables.map((x) => x.name));
  return placeholdersOf(text).filter((n) => !known.has(n));
}

/** Fills the placeholders; a missing value throws (callers pass every variable). */
export function renderMessage(text: string, vars: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (_all, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Message variable ${name} is missing`);
    return value;
  });
}

/** WhatsApp's numbered form of a body: {{guest_name}} → {{1}}. */
export function numberedBody(text: string): string {
  const order = placeholdersOf(text);
  return text.replace(PLACEHOLDER, (_all, name: string) => `{{${order.indexOf(name) + 1}}}`);
}

/** The values of a WhatsApp template's parameters, in its {{1}}, {{2}} order. */
export function whatsappParams(
  def: MessageTemplateDef,
  vars: Readonly<Record<string, string>>,
): string[] {
  if (!def.whatsapp) throw new Error(`${def.code} has no WhatsApp template`);
  return placeholdersOf(def.whatsapp.body).map((name) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Message variable ${name} is missing`);
    return value;
  });
}

/** The sample values of every variable (test messages, previews, Meta's review). */
export function exampleVars(def: MessageTemplateDef): Record<string, string> {
  return Object.fromEntries(def.variables.map((x) => [x.name, x.example]));
}
