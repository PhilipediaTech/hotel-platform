import { daysBetween, FAULT_CATEGORY_NAMES, MAX_BLOCK_DAYS, type QrFaultBody } from '@hotel/shared';
import type { z } from 'zod';
import { AppError } from '../../core/errors.ts';
import { recordEvent } from '../../core/outbox.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { propertyToday } from '../availability/inventory.ts';
import { createRoomBlock } from '../rooms/service.ts';
import { getTask, insertTask, templateOfType, dueFrom, type TaskDeps } from './service.ts';

// QR fault report (PRD M5-07, M5 rule 3, M5 AC "a critical fault set to out-of-order removes
// the room from availability within the same request"; S19 /q/:token; T-082). Each room has
// an unguessable token printed on its QR sticker; a member who scans it reports a fault there
// with a category, severity and photos. The fault becomes a FAULT task for maintenance. A
// CRITICAL fault may take the room out of order at once (a room block from today) and tells the
// general manager (event `task.critical_fault`; the message itself comes with T-024).

const invalid = (path: string, message: string) =>
  new AppError('VALIDATION_ERROR', message, {
    issues: [{ path: `body.${path}`, code: 'custom', message }],
  });

async function roomOf(deps: TaskDeps, token: string) {
  const room = await deps.tenantDb.room.findFirst({
    where: { qrToken: token, active: true },
    include: { roomType: { select: { name: true } } },
  });
  // Another property's sticker reads as unknown: tokens don't cross tenants.
  if (!room) throw new AppError('NOT_FOUND', 'This QR code does not belong to a room here.');
  return room;
}

export async function getQrRoom(deps: TaskDeps, tenant: TenantContext, token: string) {
  const room = await roomOf(deps, token);
  return {
    roomId: room.id,
    number: room.number,
    floor: room.floor,
    roomType: room.roomType.name,
    hkStatus: room.hkStatus,
    today: await propertyToday(deps.tenantDb, tenant.propertyId, deps.clock),
  };
}

export async function reportQrFault(
  deps: TaskDeps,
  tenant: TenantContext,
  token: string,
  body: z.output<typeof QrFaultBody>,
) {
  const room = await roomOf(deps, token);
  const today = await propertyToday(deps.tenantDb, tenant.propertyId, deps.clock);
  const until = body.outOfOrderUntil;
  if (until) {
    if (body.severity !== 'CRITICAL') {
      throw invalid('outOfOrderUntil', 'Only a critical fault takes the room out of order');
    }
    if (until <= today) throw invalid('outOfOrderUntil', 'The room comes back after today');
    if (daysBetween(today, until) > MAX_BLOCK_DAYS) {
      throw invalid('outOfOrderUntil', `At most ${MAX_BLOCK_DAYS} days`);
    }
  }
  const now = deps.clock();
  const task = await deps.tenantDb.$transaction(async (tx) => {
    const template = await templateOfType(tx, tenant.propertyId, 'FAULT');
    const department =
      template?.departmentId ??
      (await tx.department.findFirst({ where: { code: 'MNT' } }))?.id ??
      (await tx.department.findFirst({ orderBy: { name: 'asc' } }))?.id;
    if (!department) throw new AppError('VALIDATION_ERROR', 'The property has no departments.');
    const created = await insertTask(tx, tenant.propertyId, {
      type: 'FAULT',
      templateId: template?.id ?? null,
      departmentId: department,
      title: `${FAULT_CATEGORY_NAMES[body.category]} fault: room ${room.number}`,
      description: body.description ?? null,
      priority: body.severity,
      roomId: room.id,
      dueAt: dueFrom(now, template?.slaMinutes),
      ...(body.fileIds ? { fileIds: body.fileIds } : {}),
      reportedById: tenant.userId,
    });
    if (body.severity === 'CRITICAL') {
      await recordEvent(tx, {
        type: 'task.critical_fault',
        payload: { taskId: created.id, number: created.number, roomId: room.id },
      });
    }
    return created;
  });

  let outOfOrder: { blocked: boolean; until: string; reason: string | null } | null = null;
  if (until) {
    try {
      await createRoomBlock(deps, tenant, {
        roomId: room.id,
        kind: 'OUT_OF_ORDER',
        startDate: today,
        endDate: until,
        reason: `Critical fault, task #${task.number}`,
      });
      outOfOrder = { blocked: true, until, reason: null };
    } catch (err) {
      // The fault is reported either way; the reporter is told why the room stays on sale.
      if (!(err instanceof AppError)) throw err;
      outOfOrder = { blocked: false, until, reason: err.message };
    }
    await deps.tenantDb.task.update({
      where: { id: task.id },
      data: {
        events: {
          create: {
            kind: 'COMMENT',
            note: outOfOrder.blocked
              ? `Room ${room.number} out of order until ${until}`
              : `Room ${room.number} could not be taken out of order: ${outOfOrder.reason}`,
            byUserId: tenant.userId,
          },
        },
      },
    });
  }
  return { task: await getTask(deps, tenant, task.id), outOfOrder };
}
