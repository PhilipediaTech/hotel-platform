import { parseArgs } from 'node:util';
import { FAKE_WEBHOOK_KEY } from '../src/core/payments.ts';
import { PAYSTACK_SIGNATURE_HEADER, signPaystack } from '../src/core/paystack-events.ts';

// Local development (runbook: "the fake adapters … simulate webhooks through npm run
// simulate:webhook"; T-071). Sends the running API a Paystack-shaped `charge.success`, signed
// with the fake provider's key, as Paystack would:
//   npm run simulate:webhook -- --account 9912345678 --amount 50000 --sender "Ada Obi"
//   npm run simulate:webhook -- --reference HP-… --amount 123250
// Amounts in naira. Sending the same --id twice is a replay (it records nothing new).

const { values } = parseArgs({
  options: {
    account: { type: 'string' },
    reference: { type: 'string' },
    amount: { type: 'string' },
    sender: { type: 'string', default: 'Test Sender' },
    id: { type: 'string' },
    api: { type: 'string', default: 'http://localhost:4000' },
  },
});

if ((!values.account && !values.reference) || !values.amount) {
  console.error('Give --amount (naira) and --account (virtual account) or --reference (HP-…).');
  process.exit(1);
}
const kobo = Math.round(Number(values.amount.replaceAll(',', '')) * 100);
if (!Number.isSafeInteger(kobo) || kobo <= 0) {
  console.error('--amount must be a positive amount in naira, like 50000 or 1,250.50');
  process.exit(1);
}
const id = values.id ?? String(Date.now());
const body = JSON.stringify({
  event: 'charge.success',
  data: {
    id: Number(id),
    status: 'success',
    reference: values.reference ?? `T${id}`,
    amount: kobo,
    currency: 'NGN',
    paid_at: new Date().toISOString(),
    channel: values.account ? 'dedicated_nuban' : 'card',
    authorization: values.account
      ? { receiver_bank_account_number: values.account, sender_name: values.sender }
      : {},
  },
});
const res = await fetch(`${values.api}/api/v1/webhooks/payments/fake`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    [PAYSTACK_SIGNATURE_HEADER]: signPaystack(body, FAKE_WEBHOOK_KEY),
  },
  body,
});
console.log(`${res.status} ${await res.text()} (event charge.success:${id})`);
console.log('The worker records it within a minute (npm run dev runs the worker).');
