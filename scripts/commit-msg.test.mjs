import { describe, expect, it } from 'vitest';
import { checkCommitMessage } from './commit-msg.mjs';

describe('checkCommitMessage', () => {
  it.each([
    'T-001: monorepo, TypeScript strict, ESLint, Prettier, commit hooks',
    'T-073a: night audit steps 1-5',
    'docs: update PROGRESS after T-001',
    'chore(deps): pin prettier',
    "Merge branch 'feat/T-042-reservations'",
    'Revert "T-042: reservations create/modify/cancel"',
    'T-001: subject\n\nBody text.\n\nCo-Authored-By: Someone <x@example.com>',
    '# comment line from git\nT-002: express skeleton',
  ])('accepts %j', (message) => {
    expect(checkCommitMessage(message)).toEqual({ ok: true });
  });

  it.each([
    '',
    'wip',
    'T-42: too few digits',
    'T-001 missing colon',
    'T-001:no space',
    'feat: conventional commits are not the house style',
  ])('rejects %j', (message) => {
    expect(checkCommitMessage(message).ok).toBe(false);
  });

  it('rejects a subject over 100 characters', () => {
    const result = checkCommitMessage(`T-001: ${'x'.repeat(100)}`);
    expect(result.ok).toBe(false);
  });
});
