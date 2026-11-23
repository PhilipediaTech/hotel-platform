import { describe, expect, it } from 'vitest';
import { sameName } from './id-scan.ts';

// The ID scan's name check (PRD M14-14; T-150): for the desk, never a refusal.

describe('sameName', () => {
  it('matches the booked guest whatever the case, accents or extra given names', () => {
    expect(
      sameName({ firstName: 'ADA CHIOMA', lastName: 'OBI' }, { firstName: 'Ada', lastName: 'Obi' }),
    ).toBe(true);
    expect(
      sameName({ firstName: 'Zoë', lastName: "O'Brien" }, { firstName: 'Zoe', lastName: 'OBrien' }),
    ).toBe(true);
    expect(
      sameName(
        { firstName: 'Chioma', lastName: 'Obi' },
        { firstName: 'Ada Chioma', lastName: 'Obi' },
      ),
    ).toBe(true);
  });

  it('does not match another surname or another first name', () => {
    expect(
      sameName({ firstName: 'Ada', lastName: 'Okafor' }, { firstName: 'Ada', lastName: 'Obi' }),
    ).toBe(false);
    expect(
      sameName({ firstName: 'Ngozi', lastName: 'Obi' }, { firstName: 'Ada', lastName: 'Obi' }),
    ).toBe(false);
  });
});
