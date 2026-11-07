import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Times a night audit of the 80-room load-test hotel against the running API (PRD NFR "night
// audit for 80 rooms < 2 minutes"; spec tab 8; T-101). Run `npm run load:prepare` first and
// keep `npm run dev` running. The audit closes the day, so prepare again before another run.
//
//   npm run load:night-audit

const TARGET_MS = 120_000;

const session = JSON.parse(readFileSync(new URL('./.session.json', import.meta.url), 'utf8')) as {
  apiBase: string;
  origin: string;
  propertyId: string;
  businessDate: string;
  cookies: { nightAuditor: string };
};

const started = performance.now();
const res = await fetch(`${session.apiBase}/night-audits`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Cookie: session.cookies.nightAuditor,
    'X-Property-Id': session.propertyId,
    Origin: session.origin,
    'Idempotency-Key': randomUUID(),
  },
  body: JSON.stringify({ businessDate: session.businessDate }),
});
const ms = Math.round(performance.now() - started);
const body = (await res.json()) as {
  status?: string;
  steps?: { step: number; name: string; status: string; result: Record<string, unknown> }[];
  error?: { message: string };
};
if (res.status >= 300) {
  console.error(
    `Night audit refused (${res.status}): ${body.error?.message ?? JSON.stringify(body)}`,
  );
  process.exit(1);
}
const posting = body.steps?.find((s) => s.name === 'POST_ROOM_CHARGES' || s.step === 4);
console.log(
  `Night audit of ${session.businessDate}: ${body.status ?? '?'} in ${(ms / 1000).toFixed(1)} s`,
);
if (posting) console.log(`Room charges step: ${JSON.stringify(posting.result)}`);
console.log(ms < TARGET_MS ? `✔ Within the 2-minute target.` : `✖ Over the 2-minute target.`);
process.exit(ms < TARGET_MS && body.status === 'COMPLETED' ? 0 : 1);
