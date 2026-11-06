import { MESSAGE_TEMPLATES } from '@hotel/shared';
import { loadConfig } from '../src/core/config.ts';
import { createMetaTemplateAdmin } from '../src/core/meta-whatsapp.ts';
import { MessageSendError } from '../src/core/messaging.ts';

// Submits the platform's WhatsApp templates to Meta for approval and shows where each one
// stands (T-024). Needs WHATSAPP_PROVIDER=meta with the token and business account ID in .env:
//   npm run whatsapp:templates            (lists, then submits the missing ones)
//   npm run whatsapp:templates -- --list  (only lists)
// Templates Meta already has are never submitted again; approval takes minutes to a day.

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const w = config.whatsapp;
if (w.provider !== 'meta' || !w.token || !w.phoneNumberId) {
  console.error('Set WHATSAPP_PROVIDER=meta, WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env.');
  process.exit(1);
}
if (!w.businessAccountId) {
  console.error('Set WHATSAPP_BUSINESS_ACCOUNT_ID in .env (WhatsApp → API Setup).');
  process.exit(1);
}

const admin = createMetaTemplateAdmin({
  token: w.token,
  phoneNumberId: w.phoneNumberId,
  businessAccountId: w.businessAccountId,
  graphVersion: w.graphVersion,
});
const listOnly = process.argv.includes('--list');

try {
  const existing = await admin.list();
  const statusOf = (name: string) =>
    existing.find((t) => t.name === name && t.language === 'en')?.status;
  for (const def of MESSAGE_TEMPLATES) {
    const wa = def.whatsapp;
    if (!wa) continue;
    let status = statusOf(wa.name);
    if (!status && !listOnly) {
      try {
        status = `${(await admin.submit(def)).status} (just submitted)`;
      } catch (err) {
        status = `NOT SUBMITTED: ${err instanceof MessageSendError ? err.message : String(err)}`;
      }
    }
    console.log(`${wa.name.padEnd(20)} ${wa.category.padEnd(15)} ${status ?? 'not submitted'}`);
  }
} catch (err) {
  console.error(err instanceof MessageSendError ? err.message : (err as Error).message);
  process.exit(1);
}
