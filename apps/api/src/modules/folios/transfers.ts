import type { TransferBody } from '@hotel/shared';
import { z } from 'zod';
import {
  performOrRequest,
  type ApprovalActionHandler,
  type ExecuteContext,
} from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import { businessDate } from '../../core/business-day.ts';
import { raisedBy } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { FolioDeps } from './service.ts';
import { systemCodeId } from './system-codes.ts';

// Folio transfers (tab 4 POST /folios/{id}/transfer; PRD M1 rule 2 "folio transfer between
// guests" needs approval; T-065). An amount owed moves from a window to another window of the
// same folio, or to another open folio (a guest's company account, a paymaster account): a
// TRANSFER_OUT line takes it off, a TRANSFER_IN line puts it on, each pointing at the other
// (source_type TRANSFER). Nothing else changes (M4 rule 1). At most what the window owes.
// Between folios it goes through the folio.route approval policy; within a folio it doesn't.

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type Client = Tx | TenantDb;

const dbDate = (date: string) => new Date(`${date}T00:00:00Z`);

const TransferStored = z.object({
  folioId: z.string(),
  fromWindow: z.number(),
  toFolioId: z.string(),
  toWindow: z.number(),
  amountMinor: z.string(),
  reason: z.string(),
});
type TransferPayload = z.output<typeof TransferStored>;

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, { issues: [{ path, code: 'custom', message }] });

/** What a window owes: its lines minus its payments. */
async function windowOwes(db: Client, windowId: string): Promise<bigint> {
  const [lines, payments] = await Promise.all([
    db.folioLine.aggregate({ where: { windowId }, _sum: { amountMinor: true } }),
    db.payment.aggregate({ where: { windowId }, _sum: { baseAmountMinor: true } }),
  ]);
  return (lines._sum.amountMinor ?? 0n) - (payments._sum.baseAmountMinor ?? 0n);
}

/** Both ends, checked: open folios, the windows exist, same currency, house rights. */
async function ends(db: Client, tenant: TenantContext, p: TransferPayload) {
  const [from, to] = await Promise.all([
    db.folio.findUnique({ where: { id: p.folioId }, include: { windows: true } }),
    db.folio.findUnique({ where: { id: p.toFolioId }, include: { windows: true } }),
  ]);
  if (!from) throw new AppError('NOT_FOUND', 'Folio not found');
  if (!to) throw invalid('body.toFolioId', 'No such folio');
  for (const f of [from, to]) {
    if (f.status !== 'OPEN') {
      throw new AppError('STATE_TRANSITION_INVALID', `Folio ${f.number} is not open`, {
        folioId: f.id,
        status: f.status,
      });
    }
    if (f.kind !== 'GUEST' && !tenant.permissions.has('folio.house')) {
      throw new AppError('FORBIDDEN', 'House and paymaster accounts need folio.house', {
        permission: 'folio.house',
      });
    }
  }
  if (from.currency !== to.currency)
    throw invalid('body.toFolioId', 'The folios use different currencies');
  const source = from.windows.find((w) => w.number === p.fromWindow);
  if (!source) throw invalid('body.fromWindow', 'This folio has no such window');
  const target = to.windows.find((w) => w.number === p.toWindow);
  if (!target) throw invalid('body.toWindow', 'That folio has no such window');
  if (source.id === target.id) throw invalid('body.toWindow', 'Choose another window');
  return { from, to, source, target };
}

async function transfer(ctx: ExecuteContext & { now: Date }, p: TransferPayload): Promise<string> {
  const { tx } = ctx;
  // Locked in a fixed order, so two transfers between the same folios can't deadlock.
  for (const id of [p.folioId, p.toFolioId].sort()) {
    await tx.$queryRaw`SELECT id FROM folios WHERE id = ${id}::uuid FOR UPDATE`;
  }
  const { from, to, source, target } = await ends(tx, ctx.tenant, p);
  const amount = BigInt(p.amountMinor);
  const owes = await windowOwes(tx, source.id);
  if (amount > owes) {
    throw invalid(
      'body.amountMinor',
      owes > 0n ? 'More than the window owes' : 'This window owes nothing',
    );
  }
  const date = await businessDate(tx, from.propertyId, () => ctx.now);
  const codeId = await systemCodeId(tx, 'TRANSFER');
  const common = {
    propertyId: from.propertyId,
    businessDate: dbDate(date),
    postedAt: ctx.now,
    revenueCodeId: codeId,
    quantity: 1,
    currency: from.currency,
    sourceType: 'TRANSFER',
    postedById: ctx.tenant.userId,
    approvalRequestId: ctx.approvalRequestId,
    reason: p.reason,
  };
  try {
    const outId = crypto.randomUUID();
    const inId = crypto.randomUUID();
    await tx.folioLine.create({
      data: {
        ...common,
        id: outId,
        folioId: from.id,
        windowId: source.id,
        kind: 'TRANSFER_OUT',
        description: `Transferred to ${to.number}${to.id === from.id ? '' : ` (${to.name})`}, window ${target.number}`,
        unitAmountMinor: -amount,
        amountMinor: -amount,
        sourceId: inId,
      },
    });
    await tx.folioLine.create({
      data: {
        ...common,
        id: inId,
        folioId: to.id,
        windowId: target.id,
        kind: 'TRANSFER_IN',
        description: `Transferred from ${from.number}${to.id === from.id ? '' : ` (${from.name})`}, window ${source.number}`,
        unitAmountMinor: amount,
        amountMinor: amount,
        sourceId: outId,
      },
    });
    await recordAudit(tx, {
      action: 'folio.transferred',
      entityType: 'folio',
      entityId: from.id,
      reason: p.reason,
      approvalRequestId: ctx.approvalRequestId ?? undefined,
      after: {
        fromWindow: source.number,
        toFolioId: to.id,
        toWindow: target.number,
        amountMinor: p.amountMinor,
      },
    });
    await recordEvent(tx, {
      type: 'folio.transferred',
      payload: { fromFolioId: from.id, toFolioId: to.id, amountMinor: p.amountMinor },
    });
    return outId;
  } catch (err) {
    if (raisedBy(err, 'BUSINESS_DAY_CLOSED')) {
      throw new AppError('BUSINESS_DAY_CLOSED', 'This business day is closed');
    }
    throw err;
  }
}

export function transferHandler(deps: FolioDeps): ApprovalActionHandler<TransferPayload> {
  return {
    action: 'folio.route',
    payload: TransferStored,
    measure: (p) => ({ amountMinor: BigInt(p.amountMinor) }),
    execute: (ctx, p) => transfer({ ...ctx, now: deps.clock() }, p),
  };
}

export async function transferFolio(
  deps: FolioDeps,
  tenant: TenantContext,
  folioId: string,
  body: z.output<typeof TransferBody>,
) {
  const payload: TransferPayload = { folioId, ...body };
  // Checked up front too, so a request for approval is never made for an impossible transfer.
  const { source } = await ends(deps.tenantDb, tenant, payload);
  if (BigInt(body.amountMinor) > (await windowOwes(deps.tenantDb, source.id))) {
    throw invalid('body.amountMinor', 'More than the window owes');
  }
  let outId: string;
  if (body.toFolioId === folioId) {
    // Between windows of one folio: the same payer's bill, no approval (T-065 decision).
    outId = await deps.tenantDb.$transaction((tx) =>
      transfer({ tx, tenant, approvalRequestId: null, now: deps.clock() }, payload),
    );
  } else {
    const result = await performOrRequest(
      { db: deps.db, tenantDb: deps.tenantDb, clock: deps.clock, handlers: [] },
      tenant,
      transferHandler(deps),
      payload,
      body.reason,
    );
    if (!('resultRef' in result)) return result;
    outId = result.resultRef;
  }
  const out = await deps.tenantDb.folioLine.findUniqueOrThrow({ where: { id: outId } });
  const [lines, payments] = await Promise.all([
    deps.tenantDb.folioLine.aggregate({ where: { folioId }, _sum: { amountMinor: true } }),
    deps.tenantDb.payment.aggregate({ where: { folioId }, _sum: { baseAmountMinor: true } }),
  ]);
  return {
    lineIds: [out.id, out.sourceId ?? ''],
    balanceMinor: (
      (lines._sum.amountMinor ?? 0n) - (payments._sum.baseAmountMinor ?? 0n)
    ).toString(),
  };
}
