import { describe, expect, it } from 'vitest';
import {
  MESSAGE_TEMPLATE_CODES,
  MESSAGE_TEMPLATES,
  messageTemplateDef,
  numberedBody,
  placeholdersOf,
  renderMessage,
  unknownPlaceholders,
  whatsappParams,
} from './messages.ts';

// Message templates (T-024; PRD M11-05). The catalogue must be sendable as written.

describe('placeholders', () => {
  it('lists names in first-appearance order and numbers them for WhatsApp', () => {
    const text = 'Hi {{guest_name}}, {{ amount }} due; thanks {{guest_name}}.';
    expect(placeholdersOf(text)).toEqual(['guest_name', 'amount']);
    expect(numberedBody(text)).toBe('Hi {{1}}, {{2}} due; thanks {{1}}.');
  });

  it('renders every placeholder and refuses a missing value', () => {
    expect(renderMessage('Hi {{name}}!', { name: 'Ada' })).toBe('Hi Ada!');
    expect(() => renderMessage('Hi {{name}}', {})).toThrow('Message variable name is missing');
  });

  it('finds placeholders a template does not define', () => {
    const def = messageTemplateDef('FOLIO');
    if (!def) throw new Error('missing');
    expect(unknownPlaceholders(def, '{{folio_no}} {{total}} {{tip}}')).toEqual(['tip']);
  });

  it('gives WhatsApp parameters in the body’s order', () => {
    const def = messageTemplateDef('FEEDBACK');
    if (!def) throw new Error('missing');
    expect(whatsappParams(def, { guest_name: 'Ada', property_name: 'Obi', link: 'L' })).toEqual([
      'Ada',
      'Obi',
      'L',
    ]);
  });
});

describe('the catalogue', () => {
  it.each(MESSAGE_TEMPLATES.map((t) => [t.code, t] as const))('%s is sendable', (_code, t) => {
    const names = t.variables.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    const texts = [t.email?.subject, t.email?.body, t.whatsapp?.body].filter(
      (x): x is string => typeof x === 'string',
    );
    for (const text of texts) expect(unknownPlaceholders(t, text)).toEqual([]);
    const used = new Set(texts.flatMap(placeholdersOf));
    expect(names.filter((n) => !used.has(n))).toEqual([]);
    const wa = t.whatsapp;
    if (wa) {
      // Meta: lowercase names; a body may not start or end with a parameter.
      expect(wa.name).toMatch(/^[a-z0-9_]{1,512}$/);
      if (wa.category !== 'AUTHENTICATION') {
        expect(wa.body.trim()).not.toMatch(/^\{\{|\}\}$/);
        expect(wa.body.length).toBeLessThanOrEqual(1024);
      }
    }
  });

  it('lists the same codes as the catalogue', () => {
    expect(MESSAGE_TEMPLATES.map((t) => t.code)).toEqual([...MESSAGE_TEMPLATE_CODES]);
  });

  it('has the five guest messages of M11-05 by email and WhatsApp', () => {
    for (const code of [
      'BOOKING_CONFIRMED',
      'PRE_ARRIVAL',
      'PAYMENT_REQUEST',
      'FOLIO',
      'FEEDBACK',
    ]) {
      const def = messageTemplateDef(code);
      expect(def?.email && def.whatsapp, code).toBeTruthy();
    }
    expect(messageTemplateDef('APPROVAL_OTP')?.whatsapp?.category).toBe('AUTHENTICATION');
  });
});
