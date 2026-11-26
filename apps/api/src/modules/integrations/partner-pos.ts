import { posSettingsOf, type PartnerRoomChargeBody } from '@hotel/shared';
import type { z } from 'zod';
import type { ApiKeyContext } from '../../core/api-keys.ts';
import { recordAudit } from '../../core/audit.ts';
import { pgErrorInfo } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import { folioBalances, postChargeLines, routedWindow } from '../folios/service.ts';
import { isSystemCode } from '../folios/system-codes.ts';
import type { PartnerDeps } from './partner.ts';

// Room charges from an outside POS (Versions V2 "POS integrations"; T-167; Philip's choice:
// room number and surname). The POS lists the rooms with a guest in, the guest gives their room
// and surname at the till, and the check is charged to that stay's bill, with the hotel's taxes.
// The POS's check number is the charge's source: the same check twice posts once. Voids are the
// hotel's: a reversal at the desk, with approval as usual.

const SOURCE = 'PARTNER';
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const day = (d: Date) => d.toISOString().slice(0, 10);
const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, { issues: [{ path, code: 'custom', message }] });

/** Case, accents, spaces, hyphens and apostrophes don't matter: "O'Brien-Okafor" = "obrien okafor". */
export function sameSurname(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, '');
  return norm(a).length > 0 && norm(a) === norm(b);
}

/** A charge code a POS may post to: active, not a tax, service charge or system code. */
const chargeable = (code: { code: string; group: string; active: boolean }) =>
  code.active &&
  code.group !== 'TAX' &&
  code.group !== 'SERVICE_CHARGE' &&
  !isSystemCode(code.code);

export async function listInHouse(deps: PartnerDeps) {
  const stays = await deps.tenantDb.stay.findMany({
    where: { status: 'CHECKED_IN', folioId: { not: null }, roomId: { not: null } },
    include: { room: { select: { number: true } } },
    orderBy: [{ arrival: 'asc' }, { id: 'asc' }],
  });
  return {
    data: stays
      .flatMap((s) => (s.room ? [{ ...s, roomNumber: s.room.number }] : []))
      .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, 'en', { numeric: true }))
      .map((s) => ({
        stayId: s.id,
        roomNumber: s.roomNumber,
        arrival: day(s.arrival),
        departure: day(s.departure),
        adults: s.adults,
        children: s.children,
      })),
  };
}

export async function listRevenueCodes(deps: PartnerDeps) {
  const codes = await deps.tenantDb.revenueCode.findMany({ orderBy: { code: 'asc' } });
  return {
    data: codes.filter(chargeable).map((c) => ({ code: c.code, name: c.name, group: c.group })),
  };
}

type Body = z.output<typeof PartnerRoomChargeBody>;

/** The line already posted for this key's check number, as the POS sees it. */
async function previous(deps: PartnerDeps, sourceId: string) {
  const line = await deps.tenantDb.folioLine.findFirst({
    where: { sourceType: SOURCE, sourceId },
    include: { children: true, folio: { include: { stays: { include: { room: true } } } } },
  });
  if (!line) return null;
  const stay = line.folio.stays[0];
  return {
    line,
    out: {
      chargeId: line.id,
      stayId: stay?.id ?? '',
      roomNumber: stay?.room?.number ?? '',
      currency: line.currency,
      totalMinor: [line, ...line.children].reduce((sum, l) => sum + l.amountMinor, 0n).toString(),
      postedAt: iso(line.postedAt),
    },
  };
}

/** Answers what was posted before for the same check, or refuses one that differs. */
async function repeatOf(deps: PartnerDeps, sourceId: string, body: Body) {
  const found = await previous(deps, sourceId);
  if (!found) return null;
  const { line, out } = found;
  const code = await deps.tenantDb.revenueCode.findFirst({ where: { id: line.revenueCodeId } });
  const same =
    out.roomNumber === body.roomNumber &&
    code?.code === body.revenueCode &&
    line.quantity === body.quantity &&
    line.unitAmountMinor === BigInt(body.unitAmountMinor);
  if (!same) {
    throw new AppError(
      'IDEMPOTENCY_KEY_REUSED',
      'This check number was already posted with other details.',
      { checkNumber: body.checkNumber, chargeId: line.id },
    );
  }
  return { ...out, checkNumber: body.checkNumber, duplicate: true };
}

export async function chargeRoom(deps: PartnerDeps, key: ApiKeyContext, body: Body) {
  const sourceId = `${key.keyId}:${body.checkNumber}`;
  const again = await repeatOf(deps, sourceId, body);
  if (again) return { status: 200 as const, out: again };
  const now = deps.clock();
  try {
    const out = await deps.tenantDb.$transaction(async (tx) => {
      const stays = await tx.stay.findMany({
        where: { status: 'CHECKED_IN', room: { number: body.roomNumber } },
        include: { guest: true, occupants: true },
      });
      if (stays.length === 0) {
        throw new AppError('STATE_TRANSITION_INVALID', 'No guest is checked in to this room.', {
          roomNumber: body.roomNumber,
        });
      }
      // Anyone staying in the room may sign for it: the main guest or one added to the stay.
      const stay = stays.find(
        (s) =>
          sameSurname(s.guest.lastName, body.lastName) ||
          s.occupants.some((o) => sameSurname(o.lastName, body.lastName)),
      );
      if (!stay)
        throw invalid('body.lastName', 'The surname does not match the guest in this room');
      if (!stay.folioId) {
        throw new AppError('STATE_TRANSITION_INVALID', 'This stay has no open bill.');
      }
      const code = await tx.revenueCode.findFirst({ where: { code: body.revenueCode } });
      if (!code || !chargeable(code)) {
        throw invalid('body.revenueCode', 'Use a revenue code from /partner/revenue-codes');
      }
      // One room charge at a time per bill, so two checks can't both slip under the limit.
      await tx.$queryRaw`SELECT id FROM folios WHERE id = ${stay.folioId}::uuid FOR UPDATE`;
      const folio = await tx.folio.findUniqueOrThrow({
        where: { id: stay.folioId },
        include: { windows: true, routingRules: true, property: true },
      });
      if (folio.status !== 'OPEN') {
        throw new AppError('STATE_TRANSITION_INVALID', 'This guest’s bill is not open.', {
          status: folio.status,
        });
      }
      const windowId = routedWindow(folio, code);
      if (!windowId) throw new Error(`Folio ${folio.id} has no window 1`);
      const before = (await folioBalances(tx, [folio.id])).get(folio.id) ?? 0n;
      const lineIds = await postChargeLines(
        { tx, tenant: key.tenant, approvalRequestId: null, now },
        {
          folio,
          windowId,
          code,
          description: body.description,
          quantity: body.quantity,
          unitAmountMinor: BigInt(body.unitAmountMinor),
          note: `Check ${body.checkNumber} from an outside POS`,
          sourceType: SOURCE,
          sourceId,
          // A system's posting: no staff member, no cashier shift.
          shiftId: null,
          postedById: null,
        },
      );
      const lines = await tx.folioLine.findMany({ where: { id: { in: lineIds } } });
      const total = lines.reduce((sum, l) => sum + l.amountMinor, 0n);
      const setting = posSettingsOf(folio.property.settings).roomChargeLimitMinor;
      const limit = folio.creditLimitMinor ?? (setting === null ? null : BigInt(setting));
      if (limit !== null && before + total > limit) {
        throw new AppError(
          'CREDIT_LIMIT_EXCEEDED',
          'This would take the room over its credit limit',
          {
            limitMinor: limit.toString(),
            balanceMinor: before.toString(),
            totalMinor: total.toString(),
          },
        );
      }
      const chargeId = lineIds[0] ?? '';
      await recordAudit(tx, {
        actorType: 'SYSTEM',
        actorUserId: null,
        action: 'folio.charge_posted',
        entityType: 'folio',
        entityId: folio.id,
        after: {
          lineId: chargeId,
          revenueCode: code.code,
          quantity: body.quantity,
          unitAmountMinor: body.unitAmountMinor,
          apiKeyId: key.keyId,
          checkNumber: body.checkNumber,
        },
      });
      await recordEvent(tx, {
        type: 'folio.charge_posted',
        payload: { folioId: folio.id, lineIds },
      });
      return {
        chargeId,
        stayId: stay.id,
        roomNumber: body.roomNumber,
        checkNumber: body.checkNumber,
        currency: folio.currency,
        totalMinor: total.toString(),
        postedAt: iso(now),
        duplicate: false,
      };
    });
    return { status: 201 as const, out };
  } catch (err) {
    // The same check sent twice at once: the second one loses the race on the unique index.
    if (pgErrorInfo(err)?.constraint === 'folio_lines_partner_source_key') {
      const repeat = await repeatOf(deps, sourceId, body);
      if (repeat) return { status: 200 as const, out: repeat };
    }
    throw err;
  }
}
