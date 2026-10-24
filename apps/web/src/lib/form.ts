import type { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import type { z } from 'zod';
import i18n from '../i18n/index.ts';
import { ApiError } from './api.ts';

// Forms validate with the same Zod schemas the API uses (from @hotel/shared), so the
// browser and the server agree on every rule.

/** UI-language messages for the common rules; anything else keeps the schema's own message. */
function messageFor(issue: z.core.$ZodIssue): string {
  if (issue.code === 'too_small') {
    return issue.minimum === 1
      ? i18n.t('form.required')
      : i18n.t('form.tooShort', { min: Number(issue.minimum) });
  }
  if (issue.code === 'too_big') return i18n.t('form.tooLong', { max: Number(issue.maximum) });
  if (issue.code === 'invalid_format' && issue.format === 'email') return i18n.t('form.email');
  if (issue.code === 'invalid_value') return i18n.t('form.choose');
  return issue.message;
}

/** react-hook-form resolver for a Zod schema; values come back parsed (trimmed, lower-cased…). */
export function zodResolver<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
): Resolver<z.input<S>, unknown, z.output<S>> {
  return async (values) => {
    const result = await schema.safeParseAsync(values);
    if (result.success) return { values: result.data, errors: {} };
    const errors: Record<string, { type: string; message: string }> = {};
    for (const issue of result.error.issues) {
      const name = issue.path.join('.');
      errors[name] ??= { type: issue.code, message: messageFor(issue) };
    }
    return { values: {}, errors: errors as FieldErrors<z.input<S>> };
  };
}

/**
 * Field errors from a VALIDATION_ERROR response (`details.issues[].path` like `body.email`),
 * for fields the form has. Anything else is a form-level error.
 */
export function apiFieldErrors(error: unknown): { field: string; message: string }[] {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_ERROR') return [];
  const issues = (error.details?.['issues'] ?? []) as { path?: string; message?: string }[];
  return issues.flatMap((issue) =>
    issue.path?.startsWith('body.') && issue.message
      ? [{ field: issue.path.slice('body.'.length), message: issue.message }]
      : [],
  );
}

/** A sentence for the user about a failed call, in the UI language. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return i18n.t('errors.network');
  if (error.code === 'RATE_LIMITED') return i18n.t('errors.rateLimited');
  if (error.code === 'INTERNAL') {
    return i18n.t('errors.internal', { requestId: error.requestId ?? '—' });
  }
  // The API writes its messages for people (tab 4); codes are for branching.
  return error.message;
}
