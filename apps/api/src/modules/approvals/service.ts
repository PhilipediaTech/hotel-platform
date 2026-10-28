import {
  APPROVAL_ACTIONS,
  approvalAction,
  defaultExpiryMinutes,
  type ApprovalPolicyItem,
  type ApprovalRequestItem,
} from '@hotel/shared';
import type { z } from 'zod';
import type { ApprovalPolicy, ApprovalRequest, User } from '../../generated/prisma/client.ts';
import type { ApprovalDeps } from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import type { TenantContext } from '../../core/tenancy.ts';

// Approvals inbox and policies (PRD M1-10, M1-12; T-022). The engine (decide, execute,
// expire) is core/approvals.ts.

export const DECIDE = 'approval.decide';

type Item = z.input<typeof ApprovalRequestItem>;
type PolicyItem = z.output<typeof ApprovalPolicyItem>;
type Row = ApprovalRequest & { requestedBy: User; decidedBy: User | null };

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const person = (u: User | null) => (u ? { id: u.id, name: u.name } : null);

function toItem(
  row: Row,
  caller: TenantContext,
  policies: Map<string, ApprovalPolicy>,
  now: Date,
): Item {
  const policy = policies.get(row.action);
  const canDecide =
    row.status === 'PENDING' &&
    row.expiresAt > now &&
    caller.permissions.has(DECIDE) &&
    row.requestedById !== caller.userId &&
    (!policy || caller.roles.some((r) => policy.approverRoleIds.includes(r.id)));
  return {
    id: row.id,
    action: row.action,
    status: row.status,
    payload: row.payload as Record<string, unknown>,
    amountMinor: row.amountMinor?.toString() ?? null,
    reason: row.reason,
    requestedBy: { id: row.requestedBy.id, name: row.requestedBy.name },
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
    decidedBy: person(row.decidedBy),
    decidedAt: row.decidedAt ? iso(row.decidedAt) : null,
    decisionChannel: row.decisionChannel as Item['decisionChannel'],
    decisionNote: row.decisionNote,
    resultRef: row.resultRef,
    canDecide,
  };
}

/** Approvers see every request here; everyone else only their own. */
const visibleTo = (caller: TenantContext) =>
  caller.permissions.has(DECIDE) ? {} : { requestedById: caller.userId };

async function policyMap(deps: Pick<ApprovalDeps, 'tenantDb'>) {
  const rows = await deps.tenantDb.approvalPolicy.findMany();
  return new Map(rows.map((p) => [p.action, p]));
}

const encodeCursor = (offset: number) => Buffer.from(String(offset)).toString('base64url');
function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number(Buffer.from(cursor, 'base64url').toString());
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

export async function listApprovals(
  deps: ApprovalDeps,
  caller: TenantContext,
  query: {
    limit: number;
    cursor?: string | undefined;
    status?: ApprovalRequest['status'] | undefined;
  },
) {
  const offset = decodeCursor(query.cursor);
  const rows = await deps.tenantDb.approvalRequest.findMany({
    where: { ...visibleTo(caller), ...(query.status ? { status: query.status } : {}) },
    include: { requestedBy: true, decidedBy: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    skip: offset,
    take: query.limit + 1,
  });
  const policies = await policyMap(deps);
  const now = deps.clock();
  return {
    data: rows.slice(0, query.limit).map((r) => toItem(r, caller, policies, now)),
    nextCursor: rows.length > query.limit ? encodeCursor(offset + query.limit) : null,
  };
}

export async function getApproval(deps: ApprovalDeps, caller: TenantContext, id: string) {
  const row = await deps.tenantDb.approvalRequest.findFirst({
    where: { id, ...visibleTo(caller) },
    include: { requestedBy: true, decidedBy: true },
  });
  if (!row) throw new AppError('NOT_FOUND', 'Approval request not found.');
  return toItem(row, caller, await policyMap(deps), deps.clock());
}

// ---------------------------------------------------------------------------------------
// Policies (M1-12)

function toPolicyItem(action: string, row: ApprovalPolicy | undefined): PolicyItem {
  const def = approvalAction(action);
  return {
    action: action,
    active: row?.active ?? false,
    thresholdMinor: row?.thresholdMinor?.toString() ?? null,
    thresholdBps: row?.thresholdBps ?? null,
    approverRoleIds: row?.approverRoleIds ?? [],
    expiryMinutes: row?.expiryMinutes ?? (def ? defaultExpiryMinutes(def) : 30),
  };
}

/** Every protected action, configured or not (an unconfigured one never asks). */
export async function listPolicies(deps: Pick<ApprovalDeps, 'tenantDb'>) {
  const rows = await policyMap(deps);
  return { data: APPROVAL_ACTIONS.map((a) => toPolicyItem(a.code, rows.get(a.code))) };
}

function invalid(path: string, message: string): AppError {
  return new AppError('VALIDATION_ERROR', 'Request validation failed.', {
    issues: [{ path, code: 'custom', message }],
  });
}

export async function updatePolicies(
  deps: Pick<ApprovalDeps, 'tenantDb'>,
  policies: readonly PolicyItem[],
) {
  const seen = new Set<string>();
  const roles = await deps.tenantDb.role.findMany();
  const approverRoles = new Set(
    roles.filter((r) => r.permissions.includes(DECIDE)).map((r) => r.id),
  );
  policies.forEach((p, i) => {
    const at = `body.policies.${i}`;
    if (seen.has(p.action)) throw invalid(`${at}.action`, 'Listed twice');
    seen.add(p.action);
    const def = approvalAction(p.action);
    if (p.thresholdMinor !== null && def?.measure !== 'amount') {
      throw invalid(`${at}.thresholdMinor`, 'This action has no amount threshold');
    }
    if (p.thresholdBps !== null && def?.measure !== 'percent') {
      throw invalid(`${at}.thresholdBps`, 'This action has no percentage threshold');
    }
    if (p.thresholdMinor !== null && BigInt(p.thresholdMinor) < 0n) {
      throw invalid(`${at}.thresholdMinor`, 'Must not be negative');
    }
    const unknown = p.approverRoleIds.find((id) => !approverRoles.has(id));
    if (unknown)
      throw invalid(`${at}.approverRoleIds`, 'Approvers need a role with approval.decide');
    if (p.active && p.approverRoleIds.length === 0) {
      throw invalid(`${at}.approverRoleIds`, 'Choose at least one approver role');
    }
  });

  await deps.tenantDb.$transaction(async (tx) => {
    for (const p of policies) {
      const before = await tx.approvalPolicy.findFirst({ where: { action: p.action } });
      const data = {
        active: p.active,
        thresholdMinor: p.thresholdMinor === null ? null : BigInt(p.thresholdMinor),
        thresholdBps: p.thresholdBps,
        approverRoleIds: [...new Set(p.approverRoleIds)],
        expiryMinutes: p.expiryMinutes,
      };
      const saved = before
        ? await tx.approvalPolicy.update({ where: { id: before.id }, data })
        : await tx.approvalPolicy.create({ data: { action: p.action, ...data } as never });
      const was = toPolicyItem(p.action, before ?? undefined);
      const now = toPolicyItem(p.action, saved);
      if (JSON.stringify(was) === JSON.stringify(now)) continue;
      await recordAudit(tx, {
        action: 'approval_policy.updated',
        entityType: 'approval_policy',
        entityId: saved.id,
        before: before ? was : null,
        after: now,
      });
    }
  });
  return listPolicies(deps);
}
