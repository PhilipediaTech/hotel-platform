import { z } from 'zod';
import { APPROVAL_ACTION_CODES } from '../approvals.ts';
import { defineRoute } from './contract.ts';
import { AmountMinor, Instant, page, PageQuery, Uuid } from './primitives.ts';

// Approvals (tab 4 row "Approvals"; PRD M1-09, M1-10, M1-12; S26 policies, approvals
// inbox). T-022. Approvers (approval.decide) see every request at the property; others see
// their own.

const DECIDE = 'approval.decide';
const POLICY = 'approval.policy.manage';

export const ApprovalStatus = z
  .enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED'])
  .meta({ id: 'ApprovalStatus' });

const Person = z.object({ id: Uuid, name: z.string() });

export const ApprovalRequestItem = z
  .object({
    id: Uuid,
    action: z.string(),
    status: ApprovalStatus,
    /** The exact action as requested; approval runs it unchanged. */
    payload: z.record(z.string(), z.unknown()),
    amountMinor: AmountMinor.nullable(),
    reason: z.string(),
    requestedBy: Person,
    createdAt: Instant,
    expiresAt: Instant,
    decidedBy: Person.nullable(),
    decidedAt: Instant.nullable(),
    decisionChannel: z.enum(['APP', 'WHATSAPP_OTP']).nullable(),
    decisionNote: z.string().nullable(),
    resultRef: z.string().nullable(),
    /** The caller may approve or reject it now. */
    canDecide: z.boolean(),
  })
  .meta({ id: 'ApprovalRequest' });

export const listApprovals = defineRoute({
  operationId: 'listApprovals',
  method: 'get',
  path: '/approvals',
  summary: 'Approval requests at this property, newest first',
  tags: ['Approvals'],
  propertyScoped: true,
  query: PageQuery.extend({ status: ApprovalStatus.optional() }),
  response: page(ApprovalRequestItem),
});

export const getApproval = defineRoute({
  operationId: 'getApproval',
  method: 'get',
  path: '/approvals/{approvalId}',
  summary: 'One approval request',
  tags: ['Approvals'],
  propertyScoped: true,
  params: z.object({ approvalId: Uuid }),
  response: ApprovalRequestItem,
});

const Otp = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

export const approveApproval = defineRoute({
  operationId: 'approveApproval',
  method: 'post',
  path: '/approvals/{approvalId}/approve',
  summary: 'Approve and run the action exactly as requested',
  tags: ['Approvals'],
  propertyScoped: true,
  permission: DECIDE,
  params: z.object({ approvalId: Uuid }),
  body: z.object({
    note: z.string().max(500).optional(),
    /** Only for the WhatsApp one-time code channel. */
    otp: Otp.optional(),
  }),
  response: z.object({ status: z.literal('EXECUTED'), resultRef: z.string() }),
  errors: ['STATE_TRANSITION_INVALID', 'APPROVAL_EXPIRED'],
});

export const rejectApproval = defineRoute({
  operationId: 'rejectApproval',
  method: 'post',
  path: '/approvals/{approvalId}/reject',
  summary: 'Reject with a reason',
  tags: ['Approvals'],
  propertyScoped: true,
  permission: DECIDE,
  params: z.object({ approvalId: Uuid }),
  body: z.object({ note: z.string().trim().min(1, 'Give a reason').max(500), otp: Otp.optional() }),
  response: z.object({ status: z.literal('REJECTED') }),
  errors: ['STATE_TRANSITION_INVALID', 'APPROVAL_EXPIRED'],
});

export const ApprovalPolicyItem = z
  .object({
    action: z.enum(APPROVAL_ACTION_CODES),
    active: z.boolean(),
    /** Amount actions: approval above this many minor units; null = always. */
    thresholdMinor: AmountMinor.nullable(),
    /** Percent actions: approval above this many basis points; null = always. */
    thresholdBps: z.number().int().min(0).max(10_000).nullable(),
    approverRoleIds: z.array(Uuid),
    expiryMinutes: z.number().int().min(1).max(10_080),
  })
  .meta({ id: 'ApprovalPolicy' });

export const listApprovalPolicies = defineRoute({
  operationId: 'listApprovalPolicies',
  method: 'get',
  path: '/approval-policies',
  summary: 'The approval policy of every protected action at this property',
  tags: ['Approvals'],
  propertyScoped: true,
  permission: POLICY,
  response: z.object({ data: z.array(ApprovalPolicyItem) }),
});

export const updateApprovalPolicies = defineRoute({
  operationId: 'updateApprovalPolicies',
  method: 'put',
  path: '/approval-policies',
  summary: 'Replace the policies of the listed actions',
  tags: ['Approvals'],
  propertyScoped: true,
  permission: POLICY,
  body: z.object({ policies: z.array(ApprovalPolicyItem).min(1).max(50) }),
  response: z.object({ data: z.array(ApprovalPolicyItem) }),
});

export const APPROVAL_ROUTES = {
  listApprovals,
  getApproval,
  approveApproval,
  rejectApproval,
  listApprovalPolicies,
  updateApprovalPolicies,
} as const;
