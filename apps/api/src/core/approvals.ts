import { createHash, randomInt } from 'node:crypto';
import {
  approvalAction,
  type ApprovalActionCode,
  type ApprovalMeasure,
  type RoleLimitsValue,
} from '@hotel/shared';
import type { z } from 'zod';
import type { ApprovalRequest, Prisma } from '../generated/prisma/client.ts';
import { recordAudit } from './audit.ts';
import type { Clock } from './clock.ts';
import type { Db } from './db.ts';
import { AppError } from './errors.ts';
import { recordEvent } from './outbox.ts';
import { resolveTenant, runAsTenant, type TenantContext } from './tenancy.ts';
import type { TenantDb } from './tenant-db.ts';
import { hashToken } from './tokens.ts';

// Approvals engine (tab 2 "Approvals", PRD M1-09/M1-10, ADR-011; T-022).
//
// A module performs a protected action through `performOrRequest`. Within the caller's limit
// it runs at once; over it, the exact payload is stored as an approval request (with its
// hash and expiry) and the route answers 202. On approval the executor reloads the payload,
// checks its hash, re-validates against current state by running the same `execute` in a
// transaction as the requester, and links the result to the request. Rejected or expired
// requests never run; a request executes at most once (its status is claimed in the same
// transaction as the action).

export interface Measurement {
  amountMinor?: bigint;
  bps?: number;
  count?: number;
}

type TenantTx = Parameters<Parameters<TenantDb['$transaction']>[0]>[0];

export interface ExecuteContext {
  /** Tenant-scoped transaction client; the action's writes and audit events go through it. */
  tx: TenantTx;
  /** The requester's tenant context at the property (approval runs as them). */
  tenant: TenantContext;
  /** Set when running after approval: pass it to recordAudit's `approvalRequestId`. */
  approvalRequestId: string | null;
}

/** A protected action, defined once by the module that performs it. */
export interface ApprovalActionHandler<P = unknown> {
  action: ApprovalActionCode;
  payload: z.ZodType<P>;
  measure(payload: P): Measurement;
  /**
   * Performs the action, re-validating current state (throw AppError when it no longer
   * applies). Returns a reference to what it made, e.g. the folio line ID.
   */
  execute(ctx: ExecuteContext, payload: P): Promise<string>;
}

export interface ApprovalDeps {
  db: Db;
  tenantDb: TenantDb;
  clock: Clock;
  handlers: readonly ApprovalActionHandler<never>[];
}

const PENDING_MARK = Symbol('approvalPending');

/** What `performOrRequest` returns over the limit; `mountRoute` sends it as a 202. */
export interface ApprovalPendingResult {
  [PENDING_MARK]: true;
  approvalRequestId: string;
  status: 'PENDING';
  expiresAt: string;
  approverRoles: string[];
}

export function isApprovalPending(value: unknown): value is ApprovalPendingResult {
  return typeof value === 'object' && value !== null && PENDING_MARK in value;
}

/** Same JSON for the same data, whatever the key order; bigints as strings. */
function canonical(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const payloadHash = (payload: unknown) =>
  createHash('sha256').update(canonical(payload)).digest('hex');

/** JSON for storage: bigints become strings (handlers' Zod schemas coerce them back). */
const toJson = (payload: unknown) => JSON.parse(canonical(payload)) as Prisma.InputJsonValue;

const FIELD: Record<Exclude<ApprovalMeasure, 'none'>, keyof Measurement> = {
  amount: 'amountMinor',
  percent: 'bps',
  count: 'count',
};

/**
 * Whether the caller needs approval (spec issue 21, approved): no active policy → no;
 * caller holds one of the policy's approver roles → no (they would decide it themselves);
 * a role limit on the action's code → over it; else the policy threshold → over it; a
 * policy without a threshold → always.
 */
export async function needsApproval(
  tenantDb: TenantDb,
  tenant: TenantContext,
  action: ApprovalActionCode,
  measurement: Measurement,
): Promise<boolean> {
  const def = approvalAction(action);
  if (!def) throw new Error(`Unknown approval action ${action}`);
  const policy = await tenantDb.approvalPolicy.findFirst({ where: { action, active: true } });
  if (!policy) return false;
  if (tenant.roles.some((r) => policy.approverRoleIds.includes(r.id))) return false;
  if (def.measure === 'none') return true;

  const field = FIELD[def.measure];
  const value = measurement[field];
  if (value === undefined) throw new Error(`${action} must be measured by ${field}`);
  const asBig = (v: bigint | number | string) => BigInt(v);

  if (def.limitCode) {
    const roles = await tenantDb.role.findMany({
      where: { id: { in: tenant.roles.map((r) => r.id) } },
    });
    const limitField =
      def.measure === 'amount'
        ? 'maxAmountMinor'
        : def.measure === 'percent'
          ? 'maxBps'
          : 'maxCount';
    const limits = roles
      .map((r) => (r.limits as RoleLimitsValue)[def.limitCode ?? '']?.[limitField])
      .filter((v): v is string | number => v !== undefined)
      .map(asBig);
    // Several roles: the most generous limit applies.
    if (limits.length > 0) return asBig(value) > limits.reduce((x, y) => (y > x ? y : x));
  }
  const threshold =
    def.measure === 'amount'
      ? policy.thresholdMinor
      : def.measure === 'percent'
        ? policy.thresholdBps
        : null;
  return threshold === null ? true : asBig(value) > asBig(threshold);
}

async function approverRoleNames(tenantDb: TenantDb, roleIds: readonly string[]) {
  const roles = await tenantDb.role.findMany({ where: { id: { in: [...roleIds] } } });
  return roles.map((r) => r.name).sort();
}

/**
 * Runs a protected action now, or stores it as an approval request when it is over the
 * caller's limit. Call from a route marked `approval: true`, inside its tenant context.
 */
export async function performOrRequest<P>(
  deps: ApprovalDeps,
  tenant: TenantContext,
  handler: ApprovalActionHandler<P>,
  rawPayload: unknown,
  reason: string,
): Promise<{ resultRef: string } | ApprovalPendingResult> {
  const payload = handler.payload.parse(rawPayload);
  const measurement = handler.measure(payload);
  if (!(await needsApproval(deps.tenantDb, tenant, handler.action, measurement))) {
    const resultRef = await deps.tenantDb.$transaction((tx) =>
      handler.execute({ tx, tenant, approvalRequestId: null }, payload),
    );
    return { resultRef };
  }

  if (!reason.trim()) {
    throw new AppError('VALIDATION_ERROR', 'A reason is needed for an approval request.', {
      issues: [{ path: 'body.reason', code: 'custom', message: 'Give a reason' }],
    });
  }
  const policy = await deps.tenantDb.approvalPolicy.findFirstOrThrow({
    where: { action: handler.action, active: true },
  });
  const now = deps.clock();
  const expiresAt = new Date(now.getTime() + policy.expiryMinutes * 60_000);
  const request = await deps.tenantDb.$transaction(async (tx) => {
    const created = await tx.approvalRequest.create({
      data: {
        action: handler.action,
        payload: toJson(payload),
        payloadHash: payloadHash(payload),
        amountMinor: measurement.amountMinor ?? null,
        reason: reason.trim(),
        requestedById: tenant.userId,
        expiresAt,
        createdAt: now,
      } as never,
    });
    await recordAudit(tx, {
      action: 'approval.requested',
      entityType: 'approval_request',
      entityId: created.id,
      approvalRequestId: created.id,
      reason: created.reason,
      after: { action: handler.action, payload: toJson(payload), expiresAt },
    });
    await recordEvent(tx, {
      type: 'approval.requested',
      payload: { approvalRequestId: created.id, action: handler.action },
    });
    return created;
  });
  return {
    [PENDING_MARK]: true,
    approvalRequestId: request.id,
    status: 'PENDING',
    expiresAt: expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    approverRoles: await approverRoleNames(deps.tenantDb, policy.approverRoleIds),
  };
}

// ---------------------------------------------------------------------------------------
// Decisions

export const OTP_MAX_ATTEMPTS = 5;

export interface Decision {
  note?: string | undefined;
  /** Only for the WhatsApp channel (T-024 sends the code). */
  otp?: string | undefined;
}

/** Who may decide: approval.decide, not the requester, and one of the policy's roles. */
async function checkApprover(
  deps: ApprovalDeps,
  approver: TenantContext,
  request: ApprovalRequest,
): Promise<void> {
  if (request.requestedById === approver.userId) {
    throw new AppError('FORBIDDEN', 'You cannot decide your own request.', {
      reason: 'OWN_REQUEST',
    });
  }
  const policy = await deps.tenantDb.approvalPolicy.findFirst({
    where: { action: request.action },
  });
  if (policy && !approver.roles.some((r) => policy.approverRoleIds.includes(r.id))) {
    throw new AppError('FORBIDDEN', 'Your role cannot decide this request.', {
      reason: 'NOT_AN_APPROVER',
    });
  }
}

/** A request the caller can see and decide, still pending and in time. */
async function pendingForDecision(
  deps: ApprovalDeps,
  approver: TenantContext,
  requestId: string,
): Promise<ApprovalRequest> {
  const request = await deps.tenantDb.approvalRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new AppError('NOT_FOUND', 'Approval request not found.');
  await checkApprover(deps, approver, request);
  if (request.status !== 'PENDING') {
    throw new AppError(
      'STATE_TRANSITION_INVALID',
      `This request is already ${request.status.toLowerCase()}.`,
      {
        status: request.status,
      },
    );
  }
  if (request.expiresAt <= deps.clock()) {
    await expireRequests(deps.db, deps.clock, [request.id]);
    throw new AppError('APPROVAL_EXPIRED', 'This request has expired. Ask for a new one.');
  }
  return request;
}

/** Checks the WhatsApp code; wrong codes count, and five end the channel for this request. */
async function checkOtp(
  deps: ApprovalDeps & { otpSecret: string },
  request: ApprovalRequest,
  otp: string,
): Promise<void> {
  const usable =
    request.otpHash !== null &&
    request.otpExpiresAt !== null &&
    request.otpExpiresAt > deps.clock() &&
    request.otpAttempts < OTP_MAX_ATTEMPTS;
  if (usable && hashToken(deps.otpSecret, otp) === request.otpHash) return;
  if (usable) {
    await deps.tenantDb.approvalRequest.updateMany({
      where: { id: request.id },
      data: { otpAttempts: { increment: 1 } },
    });
  }
  throw new AppError('VALIDATION_ERROR', 'The code is wrong or no longer valid.', {
    issues: [{ path: 'body.otp', code: 'custom', message: 'The code is wrong or no longer valid' }],
  });
}

const decidedMeanwhile = () =>
  new AppError('STATE_TRANSITION_INVALID', 'This request was decided meanwhile.', {
    reason: 'DECIDED_MEANWHILE',
  });

const decided = (approver: TenantContext, now: Date, channel: string, note?: string) => ({
  decidedById: approver.userId,
  decidedAt: now,
  decisionChannel: channel,
  decisionNote: note?.trim() || null,
});

export async function rejectRequest(
  deps: ApprovalDeps & { otpSecret: string },
  approver: TenantContext,
  requestId: string,
  decision: Decision,
): Promise<{ status: 'REJECTED' }> {
  const request = await pendingForDecision(deps, approver, requestId);
  if (decision.otp !== undefined) await checkOtp(deps, request, decision.otp);
  const now = deps.clock();
  await deps.tenantDb.$transaction(async (tx) => {
    const claimed = await tx.approvalRequest.updateMany({
      where: { id: request.id, status: 'PENDING' },
      data: {
        status: 'REJECTED',
        ...decided(approver, now, decision.otp ? 'WHATSAPP_OTP' : 'APP', decision.note),
      },
    });
    if (claimed.count !== 1) {
      throw decidedMeanwhile();
    }
    await recordAudit(tx, {
      action: 'approval.rejected',
      entityType: 'approval_request',
      entityId: request.id,
      approvalRequestId: request.id,
      reason: decision.note,
      before: { status: 'PENDING' },
      after: { status: 'REJECTED' },
    });
    await recordEvent(tx, {
      type: 'approval.decided',
      payload: { approvalRequestId: request.id, status: 'REJECTED' },
    });
  });
  return { status: 'REJECTED' };
}

/**
 * Approves and executes. The status claim, the action and the result share one
 * transaction, so a request runs at most once even when approved twice at the same time.
 * If the action no longer applies, the request is marked FAILED and the caller gets 409.
 */
export async function approveRequest(
  deps: ApprovalDeps & { otpSecret: string },
  approver: TenantContext,
  requestId: string,
  decision: Decision,
): Promise<{ status: 'EXECUTED'; resultRef: string }> {
  const request = await pendingForDecision(deps, approver, requestId);
  if (decision.otp !== undefined) await checkOtp(deps, request, decision.otp);
  const channel = decision.otp ? 'WHATSAPP_OTP' : 'APP';
  const handler = deps.handlers.find((h) => h.action === request.action);
  if (!handler) throw new Error(`No handler registered for approval action ${request.action}`);
  const now = deps.clock();

  const fail = async (message: string) => {
    await deps.tenantDb.$transaction(async (tx) => {
      const claimed = await tx.approvalRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: {
          status: 'FAILED',
          ...decided(approver, now, channel, decision.note),
          resultRef: null,
        },
      });
      if (claimed.count !== 1) return;
      await recordAudit(tx, {
        action: 'approval.failed',
        entityType: 'approval_request',
        entityId: request.id,
        approvalRequestId: request.id,
        reason: message,
        before: { status: 'PENDING' },
        after: { status: 'FAILED' },
      });
      await recordEvent(tx, {
        type: 'approval.decided',
        payload: { approvalRequestId: request.id, status: 'FAILED' },
      });
    });
  };

  // The action runs as the requester, with their access as it is now.
  const requester = await resolveTenant(deps.db, request.requestedById, request.propertyId);
  const parsed = handler.payload.safeParse(request.payload);
  if (!requester || !parsed.success || payloadHash(parsed.data) !== request.payloadHash) {
    const message = !requester
      ? 'The requester no longer has access to this property.'
      : 'The stored request does not match its hash.';
    await fail(message);
    throw new AppError('STATE_TRANSITION_INVALID', message);
  }

  try {
    const resultRef = await runAsTenant(requester, () =>
      deps.tenantDb.$transaction(async (tx) => {
        const claimed = await tx.approvalRequest.updateMany({
          where: { id: request.id, status: 'PENDING', expiresAt: { gt: now } },
          data: { status: 'APPROVED', ...decided(approver, now, channel, decision.note) },
        });
        if (claimed.count !== 1) {
          throw decidedMeanwhile();
        }
        const ref = await handler.execute(
          { tx, tenant: requester, approvalRequestId: request.id },
          parsed.data,
        );
        await tx.approvalRequest.update({
          where: { id: request.id },
          data: { status: 'EXECUTED', resultRef: ref },
        });
        await recordAudit(tx, {
          action: 'approval.approved',
          entityType: 'approval_request',
          entityId: request.id,
          approvalRequestId: request.id,
          actorUserId: approver.userId,
          reason: decision.note,
          before: { status: 'PENDING' },
          after: { status: 'EXECUTED', resultRef: ref, channel },
        });
        await recordEvent(tx, {
          type: 'approval.decided',
          payload: { approvalRequestId: request.id, status: 'EXECUTED' },
        });
        return ref;
      }),
    );
    return { status: 'EXECUTED', resultRef };
  } catch (err) {
    // Lost the race to another decision: report it as is.
    if (err instanceof AppError && err.details?.['reason'] === 'DECIDED_MEANWHILE') throw err;
    if (err instanceof AppError && err.status < 500) {
      await fail(err.message);
      throw new AppError(
        'STATE_TRANSITION_INVALID',
        `The action no longer applies: ${err.message}`,
        {
          reason: err.code,
          ...(err.details ?? {}),
        },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------
// Expiry and the WhatsApp code

/** Marks pending requests past their expiry as EXPIRED (all of them, or the given IDs). */
export async function expireRequests(
  db: Db,
  clock: Clock,
  ids?: readonly string[],
): Promise<number> {
  const now = clock();
  return db.$transaction(async (tx) => {
    const due = await tx.approvalRequest.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { lte: now },
        ...(ids ? { id: { in: [...ids] } } : {}),
      },
      take: 500,
    });
    for (const request of due) {
      const done = await tx.approvalRequest.updateMany({
        where: { id: request.id, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });
      if (done.count !== 1) continue;
      const where = { organisationId: request.organisationId, propertyId: request.propertyId };
      await recordAudit(tx, {
        ...where,
        action: 'approval.expired',
        entityType: 'approval_request',
        entityId: request.id,
        approvalRequestId: request.id,
        actorType: 'SYSTEM',
        actorUserId: null,
        before: { status: 'PENDING' },
        after: { status: 'EXPIRED' },
      });
      await recordEvent(tx, {
        ...where,
        type: 'approval.decided',
        payload: { approvalRequestId: request.id, status: 'EXPIRED' },
      });
    }
    return due.length;
  });
}

/** Where WhatsApp codes go; the real channel arrives with the WhatsApp adapter (T-024). */
export interface ApprovalOtpChannel {
  send(input: { approvalRequestId: string; propertyId: string; code: string }): Promise<void>;
}

/**
 * Issues a fresh 6-digit code for a pending request (valid until the request expires) and
 * sends it through the channel. Only its HMAC is stored.
 */
export async function issueApprovalOtp(
  db: Db,
  deps: { otpSecret: string; channel: ApprovalOtpChannel },
  requestId: string,
): Promise<boolean> {
  const request = await db.approvalRequest.findUnique({ where: { id: requestId } });
  if (request?.status !== 'PENDING') return false;
  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  await db.approvalRequest.update({
    where: { id: request.id },
    data: {
      otpHash: hashToken(deps.otpSecret, code),
      otpExpiresAt: request.expiresAt,
      otpAttempts: 0,
    },
  });
  await deps.channel.send({ approvalRequestId: request.id, propertyId: request.propertyId, code });
  return true;
}
