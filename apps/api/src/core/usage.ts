import type { Db } from './db.ts';

// AI and WhatsApp use per hotel group and month, and the plan's allowance of each (M14 rules:
// "counted per hotel (usage_counters) and limited by the plan's monthly allowance"; T-118).
// An allowance left blank means no limit. The check comes before the use and the count after
// it, so calls running at the same moment can go slightly over: a few messages, not a bill.

type UsageDb = Pick<Db, 'usageCounter'>;
type AllowanceDb = Pick<Db, 'usageCounter' | 'subscription'>;

const AI_METRICS = ['AI_SUMMARY', 'AI_QUESTION', 'AI_ASSISTANT'] as const;
const WHATSAPP_METRIC = 'WHATSAPP';

/** Allowances run per calendar month. */
export const usageMonth = (at: Date) => at.toISOString().slice(0, 7);

function addUse(
  db: UsageDb,
  args: {
    organisationId: string;
    month: string;
    metric: string;
    count: number;
    inputTokens: number;
    outputTokens: number;
  },
) {
  const { count, inputTokens, outputTokens, ...key } = args;
  return db.usageCounter.upsert({
    where: { organisationId_month_metric: key },
    create: { ...key, count, inputTokens, outputTokens },
    update: {
      count: { increment: count },
      inputTokens: { increment: inputTokens },
      outputTokens: { increment: outputTokens },
    },
  });
}

/** Counts one use of AI against the hotel group, for its plan's allowance. */
export async function countAiUse(
  db: UsageDb,
  args: {
    organisationId: string;
    metric: (typeof AI_METRICS)[number];
    at: Date;
    inputTokens: number;
    outputTokens: number;
  },
) {
  const { at, ...rest } = args;
  await addUse(db, { ...rest, month: usageMonth(at), count: 1 });
}

/** Counts WhatsApp template messages sent for the hotel group. */
export async function countWhatsappSent(db: UsageDb, organisationId: string, at: Date, count = 1) {
  await addUse(db, {
    organisationId,
    month: usageMonth(at),
    metric: WHATSAPP_METRIC,
    count,
    inputTokens: 0,
    outputTokens: 0,
  });
}

/** The month's use so far: AI of every kind together, and WhatsApp template messages. */
export async function monthlyUse(db: UsageDb, organisationId: string, at: Date) {
  const month = usageMonth(at);
  const rows = await db.usageCounter.findMany({ where: { organisationId, month } });
  const total = (metrics: readonly string[]) =>
    rows.filter((r) => metrics.includes(r.metric)).reduce((n, r) => n + r.count, 0);
  return { month, aiUses: total(AI_METRICS), whatsappMessages: total([WHATSAPP_METRIC]) };
}

async function usedUp(
  db: AllowanceDb,
  organisationId: string,
  at: Date,
  pick: (
    use: Awaited<ReturnType<typeof monthlyUse>>,
    plan: { aiAllowance: number | null; whatsappAllowance: number | null },
  ) => [used: number, allowance: number | null],
): Promise<boolean> {
  const plan = await db.subscription.findUnique({
    where: { organisationId },
    select: { aiAllowance: true, whatsappAllowance: true },
  });
  if (!plan) return false;
  const [used, allowance] = pick(await monthlyUse(db, organisationId, at), plan);
  return allowance !== null && used >= allowance;
}

export const aiAllowanceUsedUp = (db: AllowanceDb, organisationId: string, at: Date) =>
  usedUp(db, organisationId, at, (use, plan) => [use.aiUses, plan.aiAllowance]);

export const whatsappAllowanceUsedUp = (db: AllowanceDb, organisationId: string, at: Date) =>
  usedUp(db, organisationId, at, (use, plan) => [use.whatsappMessages, plan.whatsappAllowance]);
