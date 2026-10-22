// commit-msg hook: enforces "T-042: summary" (ticket commits) or "docs:/chore: summary".
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const TICKET = /^T-\d{3}[a-z]?: \S/;
const HOUSEKEEPING = /^(docs|chore)(\([\w-]+\))?: \S/;
const GIT_GENERATED = /^(Merge |Revert "|fixup! |squash! )/;

/**
 * @param {string} message full commit message
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function checkCommitMessage(message) {
  const subject =
    message
      .split(/\r?\n/)
      .find((line) => line.trim() !== '' && !line.startsWith('#'))
      ?.trim() ?? '';

  if (subject === '') return { ok: false, error: 'Commit message is empty.' };
  if (GIT_GENERATED.test(subject)) return { ok: true };
  if (!TICKET.test(subject) && !HOUSEKEEPING.test(subject)) {
    return {
      ok: false,
      error: `Subject must start with "T-042: " (ticket) or "docs: " / "chore: ". Got: "${subject}"`,
    };
  }
  if (subject.length > 100) {
    return {
      ok: false,
      error: `Subject is ${subject.length} characters; keep it to 100 or fewer.`,
    };
  }
  return { ok: true };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/commit-msg.mjs <commit-msg-file>');
    process.exit(2);
  }
  const result = checkCommitMessage(readFileSync(file, 'utf8'));
  if (!result.ok) {
    console.error(`✖ ${result.error}`);
    process.exit(1);
  }
}
