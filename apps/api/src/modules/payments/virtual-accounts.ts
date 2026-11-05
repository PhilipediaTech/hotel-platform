import type {
  MatchBody,
  UnmatchedTransferItem,
  VirtualAccountBody,
  VirtualAccountItem,
} from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import { raisedBy } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { PaymentProviderError } from '../../core/payments.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { houseRights } from '../folios/service.ts';
import type { IntentDeps } from './intents.ts';
import { recordTransfer } from './webhooks.ts';

// Virtual accounts and the unmatched-transfer queue (PRD M4-08 "virtual-account details", M4
// rule 7; tab 4 POST /virtual-accounts, GET /unmatched-transfers, POST
// /unmatched-transfers/{id}/match; T-071). A virtual account is a bank account number the
// provider issues for one owner: a guest folio, or a guest (paid to their in-house folio, or
// to their one booking still to arrive). One active account per owner. A transfer no owner can
// take waits in the queue until finance (or the desk) matches it to a folio or a booking.

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, { issues: [{ path, code: 'custom', message }] });

type Account = Prisma.VirtualAccountGetPayload<object>;

function accountItem(a: Account): z.input<typeof VirtualAccountItem> {
  return {
    id: a.id,
    provider: a.provider,
    ownerType: a.ownerType,
    ownerId: a.ownerId,
    accountNumber: a.accountNumber,
    bankName: a.bankName,
    accountName: a.accountName,
    active: a.active,
  };
}

/** The account holder's name: the folio's guest, or the guest. */
async function holderOf(
  deps: IntentDeps,
  tenant: TenantContext,
  body: z.output<typeof VirtualAccountBody>,
) {
  if (body.ownerType === 'FOLIO') {
    const folio = await deps.tenantDb.folio.findUnique({
      where: { id: body.ownerId },
      include: { stays: { include: { guest: true } } },
    });
    if (!folio) throw new AppError('NOT_FOUND', 'Folio not found');
    if (folio.status !== 'OPEN') {
      throw new AppError('STATE_TRANSITION_INVALID', 'This folio is not open', {
        status: folio.status,
      });
    }
    houseRights(folio, tenant);
    const guest = folio.stays[0]?.guest;
    const [first = folio.name, ...rest] = folio.name.split(' ');
    return {
      firstName: guest?.firstName ?? first,
      lastName: guest?.lastName ?? (rest.join(' ') || first),
      label: `bill ${folio.number}`,
    };
  }
  const guest = await deps.tenantDb.guest.findUnique({ where: { id: body.ownerId } });
  if (!guest || guest.mergedIntoId) throw new AppError('NOT_FOUND', 'Guest not found');
  return { firstName: guest.firstName, lastName: guest.lastName, label: 'your stay' };
}

export async function createVirtualAccount(
  deps: IntentDeps,
  tenant: TenantContext,
  body: z.output<typeof VirtualAccountBody>,
) {
  const holder = await holderOf(deps, tenant, body);
  const existing = await deps.tenantDb.virtualAccount.findFirst({
    where: { ownerType: body.ownerType, ownerId: body.ownerId, active: true },
  });
  let account = existing;
  if (!account) {
    const issued = await deps.provider
      .createVirtualAccount({
        email: body.email,
        firstName: holder.firstName,
        lastName: holder.lastName,
        phone: body.phone.replaceAll(' ', ''),
      })
      .catch((err: unknown) => {
        if (err instanceof PaymentProviderError) {
          throw new AppError(
            'PAYMENT_PROVIDER_UNAVAILABLE',
            'The payment provider could not issue an account; try again in a minute',
          );
        }
        throw err;
      });
    account = await deps.tenantDb.$transaction(async (tx) => {
      const created = await tx.virtualAccount.create({
        data: {
          provider: deps.provider.name,
          accountNumber: issued.accountNumber,
          bankName: issued.bankName,
          accountName: issued.accountName,
          ownerType: body.ownerType,
          ownerId: body.ownerId,
        } as unknown as Prisma.VirtualAccountUncheckedCreateInput, // tenant IDs come from the client
      });
      await recordAudit(tx, {
        action: 'payment.virtual_account_issued',
        entityType: 'virtual_account',
        entityId: created.id,
        after: {
          ownerType: body.ownerType,
          ownerId: body.ownerId,
          accountNumber: issued.accountNumber,
          bankName: issued.bankName,
        },
      });
      return created;
    });
  }
  if (body.send) {
    const property = await deps.tenantDb.property.findUniqueOrThrow({
      where: { id: tenant.propertyId },
    });
    await deps.email.send({
      to: body.email,
      subject: `Bank transfer details for ${property.name}`,
      text: [
        `To pay ${property.name} for ${holder.label}, transfer to:`,
        '',
        `Bank: ${account.bankName}`,
        `Account number: ${account.accountNumber}`,
        `Account name: ${account.accountName}`,
        '',
        'This account is yours alone: what you send to it is recorded for you automatically.',
      ].join('\n'),
      tag: 'virtual-account',
    });
  }
  return accountItem(account);
}

export async function listVirtualAccounts(
  deps: IntentDeps,
  query: { ownerType: string; ownerId: string },
) {
  const rows = await deps.tenantDb.virtualAccount.findMany({
    where: { ownerType: query.ownerType, ownerId: query.ownerId },
    orderBy: { accountNumber: 'asc' },
  });
  return { data: rows.map(accountItem) };
}

// ── Unmatched transfers ─────────────────────────────────────────────────────────────────

type Unmatched = Prisma.UnmatchedTransferGetPayload<object>;

function unmatchedItem(t: Unmatched, now: Date): z.input<typeof UnmatchedTransferItem> {
  return {
    id: t.id,
    provider: t.provider,
    reference: t.externalRef,
    amountMinor: t.amountMinor.toString(),
    senderName: t.senderName,
    receivedAt: iso(t.receivedAt),
    overdue: t.matchedPaymentId === null && now.getTime() - t.receivedAt.getTime() > 86_400_000,
    matchedPaymentId: t.matchedPaymentId,
  };
}

export async function listUnmatchedTransfers(
  deps: IntentDeps,
  query: { matched?: string | undefined },
) {
  const rows = await deps.tenantDb.unmatchedTransfer.findMany({
    where:
      query.matched === undefined
        ? {}
        : { matchedPaymentId: query.matched === 'true' ? { not: null } : null },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
  });
  const now = deps.clock();
  // Still to match first (oldest first), then the matched ones.
  const open = rows.filter((r) => r.matchedPaymentId === null);
  const matched = rows.filter((r) => r.matchedPaymentId !== null).reverse();
  return { data: [...open, ...matched].map((r) => unmatchedItem(r, now)) };
}

export async function matchUnmatchedTransfer(
  deps: IntentDeps,
  tenant: TenantContext,
  id: string,
  body: z.output<typeof MatchBody>,
) {
  const now = deps.clock();
  try {
    await deps.tenantDb.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM unmatched_transfers WHERE id = ${id}::uuid FOR UPDATE`;
      const transfer = await tx.unmatchedTransfer.findUnique({ where: { id } });
      if (!transfer) throw new AppError('NOT_FOUND', 'Transfer not found');
      if (transfer.matchedPaymentId) {
        throw new AppError('STATE_TRANSITION_INVALID', 'This transfer has been matched already');
      }
      let target: Parameters<typeof recordTransfer>[1]['target'];
      if (body.folioId) {
        const folio = await tx.folio.findUnique({
          where: { id: body.folioId },
          include: { windows: true },
        });
        if (!folio) throw new AppError('NOT_FOUND', 'Folio not found');
        if (folio.status !== 'OPEN') {
          throw new AppError('STATE_TRANSITION_INVALID', 'This folio is not open', {
            status: folio.status,
          });
        }
        houseRights(folio, tenant);
        const window = folio.windows.find((w) => w.number === body.windowNumber);
        if (!window) throw invalid('body.windowNumber', 'This folio has no such window');
        target = { kind: 'folio', folioId: folio.id, windowId: window.id };
      } else {
        const reservation = await tx.reservation.findUnique({
          where: { id: body.reservationId ?? '' },
        });
        if (!reservation) throw new AppError('NOT_FOUND', 'Reservation not found');
        if (reservation.status !== 'TENTATIVE' && reservation.status !== 'CONFIRMED') {
          throw new AppError(
            'STATE_TRANSITION_INVALID',
            'Only a booking still to arrive takes a deposit',
            { status: reservation.status },
          );
        }
        target = { kind: 'deposit', reservationId: reservation.id };
      }
      // Written as the webhook writes it (the property given explicitly); typed as its client.
      const paymentId = await recordTransfer(tx as never, {
        propertyId: tenant.propertyId,
        provider: transfer.provider,
        reference: transfer.externalRef,
        amountMinor: transfer.amountMinor,
        note:
          body.note ??
          (transfer.senderName ? `Transfer from ${transfer.senderName}` : 'Bank transfer'),
        target,
        now,
        clock: deps.clock,
        userId: tenant.userId,
      });
      await tx.unmatchedTransfer.update({ where: { id }, data: { matchedPaymentId: paymentId } });
      await recordAudit(tx, {
        action: 'payment.transfer_matched',
        entityType: 'unmatched_transfer',
        entityId: id,
        after: {
          paymentId,
          ...(body.folioId ? { folioId: body.folioId } : { reservationId: body.reservationId }),
        },
        reason: body.note ?? undefined,
      });
    });
  } catch (err) {
    if (raisedBy(err, 'BUSINESS_DAY_CLOSED')) {
      throw new AppError('BUSINESS_DAY_CLOSED', 'This business day is closed');
    }
    throw err;
  }
  const row = await deps.tenantDb.unmatchedTransfer.findUniqueOrThrow({ where: { id } });
  return unmatchedItem(row, now);
}
