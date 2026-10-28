import { randomBytes } from 'node:crypto';
import {
  daysBetween,
  localDate,
  MAX_BULK_DAYS,
  MAX_REPORTED_ERRORS,
  parseCsv,
  parseSheet,
  type ImportBody,
  type ImportError,
  type ImportJobItem,
  type ImportKind,
  type RateRow,
  type RoomRow,
} from '@hotel/shared';
import { readSheet } from 'read-excel-file/node';
import type { z } from 'zod';
import type { ImportJob, Prisma, User } from '../../generated/prisma/client.ts';
import { recordAudit } from '../../core/audit.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';
import type { FileStore } from '../../core/files.ts';
import type { TenantDb } from '../../core/tenant-db.ts';
import type { TenantContext } from '../../core/tenancy.ts';
import { rebuildInventory } from '../availability/inventory.ts';
import { writeRateDays } from '../rates/service.ts';

// Spreadsheet imports (PRD M1-03; T-034). Checking reads the uploaded file once, checks
// every row (cells in @hotel/shared imports.ts, codes and clashes here) and stores the checked
// rows in the report; applying writes exactly those rows in one transaction, all or none,
// after checking them again against the property.

export interface ImportDeps {
  db: Db;
  tenantDb: TenantDb;
  store: FileStore;
  clock: Clock;
}

type Tx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];
type JobOut = z.input<typeof ImportJobItem>;
type Rows = RoomRow[] | RateRow[];

interface StoredReport {
  total: number;
  errorCount: number;
  errors: ImportError[];
  summary: Record<string, number>;
  preview: Record<string, unknown>[];
  applied: Record<string, number> | null;
  /** The checked rows apply writes (not sent to the browser). */
  data: Rows;
}

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];

function jobItem(job: ImportJob & { createdBy: User }): JobOut {
  const report = job.report as unknown as StoredReport;
  return {
    id: job.id,
    kind: job.kind as ImportKind,
    status: job.status as JobOut['status'],
    fileId: job.fileId,
    createdAt: iso(job.createdAt),
    createdBy: { id: job.createdBy.id, name: job.createdBy.name },
    report: {
      total: report.total,
      errorCount: report.errorCount,
      errors: report.errors,
      summary: report.summary,
      preview: report.preview as JobOut['report']['preview'],
      applied: report.applied,
    },
  };
}

// ── Reading the file ───────────────────────────────────────────────────────────────────

/** Spreadsheet cells as text: dates as YYYY-MM-DD, booleans as yes/no. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return String(value);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function readTable(bytes: Buffer, contentType: string): Promise<string[][] | null> {
  try {
    if (contentType === 'text/csv') return parseCsv(bytes.toString('utf8'));
    const rows = await readSheet(bytes);
    return rows.map((row) => row.map(cellText));
  } catch {
    return null; // not a spreadsheet we can read
  }
}

// ── Checks against the property ────────────────────────────────────────────────────────

interface Checked {
  errors: ImportError[];
  summary: Record<string, number>;
}

async function checkRooms(tx: Tx | TenantDb, rows: RoomRow[]): Promise<Checked> {
  const errors: ImportError[] = [];
  const types = new Map((await tx.roomType.findMany()).map((t) => [t.code, t]));
  const rooms = new Set(
    (await tx.room.findMany({ select: { number: true } })).map((r) => r.number),
  );
  const seenRooms = new Map<string, number>();
  // A new type is defined by its first row; later rows must agree.
  const newTypes = new Map<string, RoomRow>();
  const updatedTypes = new Set<string>();
  let roomsNew = 0;
  let roomsUpdated = 0;
  for (const r of rows) {
    const first = seenRooms.get(r.roomNumber);
    if (first !== undefined) {
      errors.push({
        row: r.row,
        column: 'room_number',
        message: `Room ${r.roomNumber} is already on row ${first}`,
      });
      continue;
    }
    seenRooms.set(r.roomNumber, r.row);
    const existing = types.get(r.roomTypeCode);
    if (existing) {
      if (!existing.active) {
        errors.push({
          row: r.row,
          column: 'room_type_code',
          message: `Room type ${r.roomTypeCode} is inactive`,
        });
        continue;
      }
      const changes =
        (r.roomTypeName !== null && r.roomTypeName !== existing.name) ||
        (r.baseOccupancy !== null && r.baseOccupancy !== existing.baseOccupancy) ||
        (r.maxOccupancy !== null && r.maxOccupancy !== existing.maxOccupancy);
      if (changes) updatedTypes.add(r.roomTypeCode);
      const base = r.baseOccupancy ?? existing.baseOccupancy;
      const max = r.maxOccupancy ?? existing.maxOccupancy;
      if (base > max) {
        errors.push({
          row: r.row,
          column: 'max_occupancy',
          message: 'Must be at least the base occupancy',
        });
        continue;
      }
    } else {
      const defined = newTypes.get(r.roomTypeCode);
      if (!defined) {
        if (r.roomTypeName === null) {
          errors.push({
            row: r.row,
            column: 'room_type_name',
            message: `New room type ${r.roomTypeCode} needs a name`,
          });
          continue;
        }
        newTypes.set(r.roomTypeCode, r);
      } else if (
        (r.roomTypeName !== null && r.roomTypeName !== defined.roomTypeName) ||
        (r.baseOccupancy !== null && r.baseOccupancy !== defined.baseOccupancy) ||
        (r.maxOccupancy !== null && r.maxOccupancy !== defined.maxOccupancy)
      ) {
        errors.push({
          row: r.row,
          column: 'room_type_code',
          message: `Room type ${r.roomTypeCode} is described differently on row ${defined.row}`,
        });
        continue;
      }
    }
    if (rooms.has(r.roomNumber)) roomsUpdated++;
    else roomsNew++;
  }
  return {
    errors,
    summary: {
      roomTypesNew: newTypes.size,
      roomTypesUpdated: updatedTypes.size,
      roomsNew,
      roomsUpdated,
    },
  };
}

async function checkRates(tx: Tx | TenantDb, rows: RateRow[], today: string): Promise<Checked> {
  const errors: ImportError[] = [];
  const plans = new Map((await tx.ratePlan.findMany()).map((p) => [p.code, p]));
  const types = new Map((await tx.roomType.findMany()).map((t) => [t.code, t]));
  const ranges = new Map<string, { from: string; to: string; row: number }[]>();
  let days = 0;
  for (const r of rows) {
    const plan = plans.get(r.ratePlanCode);
    const type = types.get(r.roomTypeCode);
    const fail = (column: string, message: string) => errors.push({ row: r.row, column, message });
    if (!plan?.active) {
      fail('rate_plan_code', `No active rate plan ${r.ratePlanCode}`);
      continue;
    }
    if (!type?.active) {
      fail('room_type_code', `No active room type ${r.roomTypeCode}`);
      continue;
    }
    if (plan.roomTypeIds.length > 0 && !plan.roomTypeIds.includes(type.id)) {
      fail('room_type_code', `${plan.code} does not sell ${type.code}`);
      continue;
    }
    if (plan.kind === 'DERIVED' && r.amountMinor !== undefined) {
      fail('price', `${plan.code} follows its parent’s prices; leave the price empty`);
      continue;
    }
    if (r.from < today) {
      fail('from', 'Prices and restrictions change from today on');
      continue;
    }
    if (daysBetween(r.from, r.to) + 1 > MAX_BULK_DAYS) {
      fail('to', `At most ${MAX_BULK_DAYS} days per row`);
      continue;
    }
    // Two rows for the same plan, type and day would depend on their order.
    const key = `${plan.id}|${type.id}`;
    const clash = (ranges.get(key) ?? []).find((x) => x.from <= r.to && r.from <= x.to);
    if (clash) {
      fail('from', `Overlaps row ${clash.row} for ${plan.code} ${type.code}`);
      continue;
    }
    ranges.set(key, [...(ranges.get(key) ?? []), { from: r.from, to: r.to, row: r.row }]);
    days += daysBetween(r.from, r.to) + 1;
  }
  return { errors, summary: { rateLines: rows.length, days } };
}

async function todayAt(deps: ImportDeps, tenant: TenantContext): Promise<string> {
  const { timeZone } = await deps.db.property.findUniqueOrThrow({
    where: { id: tenant.propertyId },
    select: { timeZone: true },
  });
  return localDate(deps.clock(), timeZone);
}

function previewOf(rows: Rows): Record<string, unknown>[] {
  return rows.slice(0, 20).map((r) => ({ ...r }));
}

// ── Validate ───────────────────────────────────────────────────────────────────────────

export async function validateImport(
  deps: ImportDeps,
  tenant: TenantContext,
  body: z.output<typeof ImportBody>,
): Promise<JobOut> {
  const file = await deps.tenantDb.fileObject.findUnique({ where: { id: body.fileId } });
  if (file?.entityType !== 'ImportJob') {
    throw new AppError('VALIDATION_ERROR', 'Upload the spreadsheet first', {
      issues: [{ path: 'body.fileId', code: 'custom', message: 'Not an uploaded import file' }],
    });
  }
  if (file.scan !== 'CLEAN') {
    throw new AppError(
      'FILE_NOT_READY',
      file.scan === 'PENDING'
        ? 'The file is still being checked'
        : 'The file was blocked by the scan',
      { scan: file.scan },
    );
  }
  const today = await todayAt(deps, tenant);
  const table = await readTable(await deps.store.read(file.storageKey), file.contentType);

  let rows: Rows = [];
  let total = 0;
  let errors: ImportError[];
  let summary: Record<string, number> = {};
  if (!table) {
    errors = [{ row: null, column: null, message: 'This file could not be read as a spreadsheet' }];
  } else if (body.kind === 'ROOMS') {
    const sheet = parseSheet('ROOMS', table);
    const checked = await checkRooms(deps.tenantDb, sheet.rows);
    ({ total } = sheet);
    rows = sheet.rows;
    errors = [...sheet.errors, ...checked.errors];
    summary = checked.summary;
  } else {
    const sheet = parseSheet('RATES', table);
    const checked = await checkRates(deps.tenantDb, sheet.rows, today);
    ({ total } = sheet);
    rows = sheet.rows;
    errors = [...sheet.errors, ...checked.errors];
    summary = checked.summary;
  }
  if (table && total === 0 && errors.length === 0) {
    errors.push({ row: null, column: null, message: 'The file has no rows under the header' });
  }
  errors.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));

  const report: StoredReport = {
    total,
    errorCount: errors.length,
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
    summary,
    preview: previewOf(rows),
    applied: null,
    data: errors.length === 0 ? rows : [],
  };
  return deps.tenantDb.$transaction(async (tx) => {
    const job = await tx.importJob.create({
      data: {
        kind: body.kind,
        fileId: file.id,
        status: errors.length === 0 ? 'VALIDATED' : 'FAILED',
        report: report as unknown as Prisma.InputJsonValue,
        createdById: tenant.userId,
      } as Prisma.ImportJobUncheckedCreateInput,
      include: { createdBy: true },
    });
    await tx.fileObject.update({ where: { id: file.id }, data: { entityId: job.id } });
    return jobItem(job);
  });
}

export async function getImport(deps: ImportDeps, importId: string): Promise<JobOut> {
  const job = await deps.tenantDb.importJob.findUnique({
    where: { id: importId },
    include: { createdBy: true },
  });
  if (!job) throw new AppError('NOT_FOUND', 'Import not found');
  return jobItem(job);
}

// ── Apply ──────────────────────────────────────────────────────────────────────────────

async function applyRooms(tx: Tx, propertyId: string, today: string, rows: RoomRow[]) {
  const types = new Map((await tx.roomType.findMany()).map((t) => [t.code, t]));
  const nextSort = Math.max(0, ...[...types.values()].map((t) => t.sortOrder + 1));
  let sort = nextSort;
  for (const r of rows) {
    const existing = types.get(r.roomTypeCode);
    const fields = {
      ...(r.roomTypeName !== null ? { name: r.roomTypeName } : {}),
      ...(r.baseOccupancy !== null ? { baseOccupancy: r.baseOccupancy } : {}),
      ...(r.maxOccupancy !== null ? { maxOccupancy: r.maxOccupancy } : {}),
    };
    if (!existing) {
      const created = await tx.roomType.create({
        data: {
          code: r.roomTypeCode,
          name: r.roomTypeName ?? r.roomTypeCode,
          baseOccupancy: r.baseOccupancy ?? 2,
          maxOccupancy: r.maxOccupancy ?? Math.max(2, r.baseOccupancy ?? 2),
          sortOrder: sort++,
        } as Prisma.RoomTypeUncheckedCreateInput,
      });
      types.set(created.code, created);
    } else if (Object.keys(fields).length > 0) {
      types.set(
        existing.code,
        await tx.roomType.update({ where: { id: existing.id }, data: fields }),
      );
    }
  }
  const rooms = new Map((await tx.room.findMany()).map((r) => [r.number, r]));
  let roomsWritten = 0;
  for (const r of rows) {
    const type = types.get(r.roomTypeCode);
    if (!type) continue;
    const fields = {
      roomTypeId: type.id,
      floor: r.floor,
      building: r.building,
      features: r.features,
    };
    const existing = rooms.get(r.roomNumber);
    if (existing) {
      await tx.room.update({
        where: { id: existing.id },
        data: { ...fields, version: { increment: 1 } },
      });
    } else {
      await tx.room.create({
        data: {
          ...fields,
          number: r.roomNumber,
          qrToken: randomBytes(16).toString('base64url'),
        } as Prisma.RoomUncheckedCreateInput,
      });
    }
    roomsWritten++;
  }
  await rebuildInventory(
    tx,
    propertyId,
    today,
    [...types.values()].map((type) => type.id),
  );
  return { roomsWritten };
}

async function applyRates(tx: Tx, propertyId: string, rows: RateRow[]) {
  const plans = new Map((await tx.ratePlan.findMany()).map((p) => [p.code, p]));
  const types = new Map((await tx.roomType.findMany()).map((t) => [t.code, t]));
  let daysChanged = 0;
  for (const r of rows) {
    const plan = plans.get(r.ratePlanCode);
    const type = types.get(r.roomTypeCode);
    if (!plan || !type) continue;
    const { row: _row, ratePlanCode: _p, roomTypeCode: _t, from, to, ...set } = r;
    daysChanged += await writeRateDays(tx, propertyId, plan.id, {
      roomTypeIds: [type.id],
      from,
      to,
      weekdays: ALL_WEEKDAYS,
      set,
    });
  }
  return { daysChanged };
}

export async function applyImport(
  deps: ImportDeps,
  tenant: TenantContext,
  importId: string,
): Promise<JobOut> {
  const today = await todayAt(deps, tenant);
  try {
    return await deps.tenantDb.$transaction(
      async (tx) => {
        const job = await tx.importJob.findUnique({ where: { id: importId } });
        if (!job) throw new AppError('NOT_FOUND', 'Import not found');
        // One apply at a time per import.
        await tx.$queryRaw`SELECT id FROM import_jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
        const fresh = await tx.importJob.findUniqueOrThrow({ where: { id: job.id } });
        if (fresh.status !== 'VALIDATED') {
          throw new AppError(
            'STATE_TRANSITION_INVALID',
            fresh.status === 'APPLIED'
              ? 'This import was already applied'
              : 'Fix the errors in the file and upload it again',
            { status: fresh.status },
          );
        }
        const report = fresh.report as unknown as StoredReport;
        // The property may have changed since the check (rooms added, plans deactivated).
        const again =
          fresh.kind === 'ROOMS'
            ? await checkRooms(tx, report.data as RoomRow[])
            : await checkRates(tx, report.data as RateRow[], today);
        if (again.errors.length > 0) {
          throw new AppError(
            'STATE_TRANSITION_INVALID',
            'The property changed since the file was checked; check it again',
            { errors: again.errors.slice(0, 20) },
          );
        }
        const applied =
          fresh.kind === 'ROOMS'
            ? await applyRooms(tx, tenant.propertyId, today, report.data as RoomRow[])
            : await applyRates(tx, tenant.propertyId, report.data as RateRow[]);
        const updated = await tx.importJob.update({
          where: { id: fresh.id },
          data: {
            status: 'APPLIED',
            report: {
              ...report,
              summary: again.summary,
              applied,
            } as unknown as Prisma.InputJsonValue,
          },
          include: { createdBy: true },
        });
        await recordAudit(tx, {
          action: 'import.applied',
          entityType: 'import_job',
          entityId: fresh.id,
          after: {
            kind: fresh.kind,
            fileId: fresh.fileId,
            rows: report.total,
            ...again.summary,
            ...applied,
          },
        });
        return jobItem(updated);
      },
      { timeout: 120_000 },
    );
  } catch (err) {
    // Rates: a max stay below a min stay already set on some day.
    if (pgErrorInfo(err)?.constraint === 'rate_days_stay_check') {
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        'On some days the maximum stay would be below the minimum stay already set',
      );
    }
    throw err;
  }
}
