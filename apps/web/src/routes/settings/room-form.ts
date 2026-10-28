import type { z } from 'zod';
import i18n from '../../i18n/index.ts';
import { apiFieldErrors } from '../../lib/form.ts';

// Small helpers shared by the room type and room forms (S24).

export type FieldErrors = Record<string, string>;

/** The form's own check failed; `fields` holds the messages by field. */
export class FormErrors extends Error {
  readonly fields: FieldErrors;
  constructor(fields: FieldErrors) {
    super('Form has errors');
    this.name = 'FormErrors';
    this.fields = fields;
  }
}

/** Checks a payload with the API's own schema; throws FormErrors keyed by top-level field. */
export function validated<S extends z.ZodType>(schema: S, payload: unknown): z.output<S> {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? '');
    errors[field] ??=
      issue.code === 'too_small' && issue.minimum === 1 ? i18n.t('form.required') : issue.message;
  }
  throw new FormErrors(errors);
}

/** Messages per field from the form's check or from the API's validation answer. */
export function fieldErrorsOf(error: unknown): FieldErrors {
  return error instanceof FormErrors ? error.fields : serverErrors(error);
}

/** Field errors from a VALIDATION_ERROR answer, keyed by top-level field. */
export function serverErrors(error: unknown): FieldErrors {
  return Object.fromEntries(
    apiFieldErrors(error).map(({ field, message }) => [field.split('.')[0] ?? field, message]),
  );
}

/** "King bed, Wi-Fi" ↔ ['King bed', 'Wi-Fi']. */
export const labelsFrom = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
export const labelsText = (labels: readonly string[]): string => labels.join(', ');

/** `2026-11-13` → "13 Nov" in the user's language (calendar dates have no time zone). */
export function shortDate(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}
