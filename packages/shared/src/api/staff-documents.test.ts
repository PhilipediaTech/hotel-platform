import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STAFF_DOCUMENT_RETENTION,
  keptUntil,
  staffDocumentRetentionOf,
} from './staff-documents.ts';

describe('staff document retention', () => {
  it('counts months from the last day', () => {
    expect(keptUntil('2026-11-01', 12)).toBe('2027-11-01');
    expect(keptUntil('2026-11-01', 72)).toBe('2032-11-01');
    // No 31 February: the last day of the month.
    expect(keptUntil('2026-08-31', 6)).toBe('2027-02-28');
  });

  it('falls back to the defaults', () => {
    expect(staffDocumentRetentionOf(undefined)).toEqual(DEFAULT_STAFF_DOCUMENT_RETENTION);
    expect(staffDocumentRetentionOf({ CONTRACT: 0 })).toEqual(DEFAULT_STAFF_DOCUMENT_RETENTION);
  });
});
