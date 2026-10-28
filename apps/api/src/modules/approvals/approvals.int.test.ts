import { defineRoute, type ApprovalRequestItem } from '@hotel/shared';
import express from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  expireRequests,
  issueApprovalOtp,
  performOrRequest,
  type ApprovalActionHandler,
} from '../../core/approvals.ts';
import { recordAudit } from '../../core/audit.ts';
import { AppError } from '../../core/errors.ts';
import { mountRoute } from '../../core/route.ts';
import { createTenantDb } from '../../core/tenant-db.ts';
import { authApi, PASSWORD, tokenFromEmail } from '../../../test/auth.ts';
import { resetDb, testDb } from '../../../test/db.ts';
import { errorOf, TEST_CONFIG } from '../../../test/helpers.ts';
import { hotelClient, makeHotel as makeHotelIn } from '../../../test/hotel.ts';
import { sessionCookie } from '../../../test/tenancy.ts';
import { createDefaultApprovalPolicies } from './defaults.ts';

// Approvals (PRD M1-09, M1-10, M1-12; tab 2 "Approvals"; T-022). A test action stands in
// for the real protected actions (discounts arrive with folios, T-04x).

const db = testDb();
const tenantDb = createTenantDb(db);

let now: Date;
const clock = () => new Date(now);

// The test action: "apply a discount" writes an audit event and returns its ID.
let applied: { bps: number; approvalRequestId: string | null; actor: string | null }[] = [];
let stale = false;
const discount: ApprovalActionHandler<{ folioId: string; bps: number }> = {
  action: 'folio.discount',
  payload: z.object({ folioId: z.string(), bps: z.number().int() }),
  measure: (p) => ({ bps: p.bps }),
  async execute({ tx, tenant, approvalRequestId }, p) {
    if (stale) throw new AppError('STATE_TRANSITION_INVALID', 'The folio is closed.');
    applied.push({ bps: p.bps, approvalRequestId, actor: tenant.userId });
    await recordAudit(tx, {
      action: 'folio.discounted',
      entityType: 'folio',
      entityId: p.folioId,
      after: { bps: p.bps },
      approvalRequestId: approvalRequestId ?? undefined,
    });
    return `discount-${applied.length}`;
  },
};
const HANDLERS = [discount] as const;

const applyDiscount = defineRoute({
  operationId: 'applyDiscount',
  method: 'post',
  path: '/test/discounts',
  summary: 'Test protected action',
  tags: ['Test'],
  propertyScoped: true,
  permission: 'folio.discount',
  approval: true,
  body: z.object({ folioId: z.string(), bps: z.number().int(), reason: z.string() }),
  status: 201,
  response: z.object({ resultRef: z.string() }),
});

function testRoutes() {
  const router = express.Router();
  mountRoute(router, applyDiscount, ({ body }, { tenant }) =>
    performOrRequest(
      { db, tenantDb, clock, handlers: HANDLERS as never },
      tenant as never,
      discount,
      { folioId: body.folioId, bps: body.bps },
      body.reason,
    ),
  );
  return router;
}

async function hotel() {
  const h = await makeHotelIn(db, now);
  await createDefaultApprovalPolicies(db, h.org.id, h.p1.id);
  const c = hotelClient(db, clock, h.p1.id, {
    routes: testRoutes(),
    approvalHandlers: HANDLERS as never,
  });
  const as = async (userId: string) => c.as(await sessionCookie(db, userId));
  return { ...h, c, as };
}

type Item = z.output<typeof ApprovalRequestItem>;

beforeEach(async () => {
  await resetDb(db);
  now = new Date();
  applied = [];
  stale = false;
});

const discountBody = (bps: number) => ({ folioId: 'F-1', bps, reason: 'Loyal guest' });

describe('over the limit: a request instead of failing (M1-09)', () => {
  it('runs within the limit; above it answers 202 and changes nothing', async () => {
    const h = await hotel();
    const fd = await h.as(h.fd.id);
    const within = await fd.post('/test/discounts', discountBody(1000));
    expect(within.status).toBe(201);
    expect(applied).toEqual([{ bps: 1000, approvalRequestId: null, actor: h.fd.id }]);

    const over = await fd.post('/test/discounts', discountBody(2000));
    expect(over.status).toBe(202);
    expect(over.body).toMatchObject({
      status: 'PENDING',
      approverRoles: ['General Manager', 'Owner'],
    });
    const body = over.body as { approvalRequestId: string; expiresAt: string };
    // Rule 3: front-desk actions wait 30 minutes.
    expect(new Date(body.expiresAt).getTime() - now.getTime()).toBeCloseTo(30 * 60_000, -4);
    expect(applied).toHaveLength(1);
    const request = await db.approvalRequest.findUniqueOrThrow({
      where: { id: body.approvalRequestId },
    });
    expect(request).toMatchObject({
      status: 'PENDING',
      action: 'folio.discount',
      payload: { folioId: 'F-1', bps: 2000 },
      reason: 'Loyal guest',
      requestedById: h.fd.id,
    });
    const events = await db.domainEvent.findMany();
    expect(events.map((e) => e.type)).toEqual(['approval.requested']);
  });

  it('a role limit wins over the policy threshold (issue 21)', async () => {
    const h = await hotel();
    await db.role.update({
      where: { id: h.role('front-desk') },
      data: { limits: { 'folio.discount': { maxBps: 2500 } } },
    });
    const fd = await h.as(h.fd.id);
    expect((await fd.post('/test/discounts', discountBody(2000))).status).toBe(201);
    expect((await fd.post('/test/discounts', discountBody(3000))).status).toBe(202);
  });

  it('lets approvers act directly, and asks nothing without an active policy', async () => {
    const h = await hotel();
    expect((await (await h.as(h.gm.id)).post('/test/discounts', discountBody(5000))).status).toBe(
      201,
    );
    await db.approvalPolicy.updateMany({ data: { active: false } });
    expect((await (await h.as(h.fd.id)).post('/test/discounts', discountBody(5000))).status).toBe(
      201,
    );
  });

  it('needs a reason for the request', async () => {
    const h = await hotel();
    const res = await (
      await h.as(h.fd.id)
    ).post('/test/discounts', {
      ...discountBody(2000),
      reason: ' ',
    });
    expect(res.status).toBe(400);
    expect(await db.approvalRequest.count()).toBe(0);
  });
});

async function pendingRequest(h: Awaited<ReturnType<typeof hotel>>, bps = 2000) {
  const res = await (await h.as(h.fd.id)).post('/test/discounts', discountBody(bps));
  return (res.body as { approvalRequestId: string }).approvalRequestId;
}

describe('deciding (M1-10)', () => {
  it('approval runs the action exactly as requested, once, as the requester', async () => {
    const h = await hotel();
    const id = await pendingRequest(h);
    const gm = await h.as(h.gm.id);
    const [a, b] = await Promise.all([
      gm.post(`/approvals/${id}/approve`, { note: 'OK, corporate guest' }),
      gm.post(`/approvals/${id}/approve`, {}),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(applied).toEqual([{ bps: 2000, approvalRequestId: id, actor: h.fd.id }]);
    const request = await db.approvalRequest.findUniqueOrThrow({ where: { id } });
    expect(request).toMatchObject({
      status: 'EXECUTED',
      decidedById: h.gm.id,
      decisionChannel: 'APP',
      resultRef: 'discount-1',
    });
    const audit = await db.auditEvent.findMany({
      where: { approvalRequestId: id },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((e) => [e.action, e.actorUserId])).toEqual([
      ['approval.requested', h.fd.id],
      ['folio.discounted', h.fd.id],
      ['approval.approved', h.gm.id],
    ]);
  });

  it('a second submission of the same approval does not run it again', async () => {
    const h = await hotel();
    const id = await pendingRequest(h);
    const gm = await h.as(h.gm.id);
    await gm.post(`/approvals/${id}/approve`, {}).expect(200);
    const again = await gm.post(`/approvals/${id}/approve`, {});
    expect(errorOf(again).code).toBe('STATE_TRANSITION_INVALID');
    expect(applied).toHaveLength(1);
  });

  it('the requester cannot decide their own request; only the policy’s roles can', async () => {
    const h = await hotel();
    const lite = await db.role.create({
      data: {
        organisationId: h.org.id,
        name: 'Shift lead',
        permissions: ['approval.decide', 'folio.discount'],
      },
    });
    for (const user of [h.fd, await h.person('staff', h.p1.id)]) {
      await db.membership.create({
        data: { userId: user.id, organisationId: h.org.id, propertyId: h.p1.id, roleId: lite.id },
      });
    }
    const id = await pendingRequest(h);
    const own = await (await h.as(h.fd.id)).post(`/approvals/${id}/approve`, {});
    expect(errorOf(own)).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'OWN_REQUEST' } });
    const staff = await db.membership.findFirstOrThrow({
      where: { roleId: lite.id, userId: { not: h.fd.id } },
    });
    const other = await (await h.as(staff.userId)).post(`/approvals/${id}/approve`, {});
    expect(errorOf(other)).toMatchObject({ details: { reason: 'NOT_AN_APPROVER' } });
    expect(applied).toHaveLength(0);
  });

  it('rejection needs a reason and never runs the action', async () => {
    const h = await hotel();
    const id = await pendingRequest(h);
    const owner = await h.as(h.owner.id);
    expect((await owner.post(`/approvals/${id}/reject`, { note: '' })).status).toBe(400);
    await owner.post(`/approvals/${id}/reject`, { note: 'Too generous' }).expect(200);
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'REJECTED',
      decisionNote: 'Too generous',
    });
    expect(errorOf(await owner.post(`/approvals/${id}/approve`, {})).code).toBe(
      'STATE_TRANSITION_INVALID',
    );
    expect(applied).toHaveLength(0);
  });

  it('expired requests cannot execute (rule 3)', async () => {
    const h = await hotel();
    const id = await pendingRequest(h);
    now = new Date(now.getTime() + 31 * 60_000);
    const res = await (await h.as(h.gm.id)).post(`/approvals/${id}/approve`, {});
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe('APPROVAL_EXPIRED');
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id } })).status).toBe('EXPIRED');
    expect(applied).toHaveLength(0);
  });

  it('the expiry job expires overdue requests and leaves the rest', async () => {
    const h = await hotel();
    const overdue = await pendingRequest(h);
    now = new Date(now.getTime() + 20 * 60_000);
    const fresh = await pendingRequest(h);
    now = new Date(now.getTime() + 15 * 60_000);
    expect(await expireRequests(db, clock)).toBe(1);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: overdue } })).status).toBe(
      'EXPIRED',
    );
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id: fresh } })).status).toBe(
      'PENDING',
    );
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'approval.expired' } });
    expect(audit).toMatchObject({ actorType: 'SYSTEM', approvalRequestId: overdue });
  });

  it('re-validates on approval: an action that no longer applies fails and is recorded', async () => {
    const h = await hotel();
    const id = await pendingRequest(h);
    stale = true;
    const res = await (await h.as(h.gm.id)).post(`/approvals/${id}/approve`, {});
    expect(res.status).toBe(409);
    expect(errorOf(res).message).toMatch(/folio is closed/);
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'FAILED',
      decidedById: h.gm.id,
    });
  });

  it('never runs a payload changed after the request (hash check)', async () => {
    const h = await hotel();
    const id = await pendingRequest(h);
    await db.approvalRequest.update({
      where: { id },
      data: { payload: { folioId: 'F-1', bps: 9000 } },
    });
    const res = await (await h.as(h.gm.id)).post(`/approvals/${id}/approve`, {});
    expect(res.status).toBe(409);
    expect(applied).toHaveLength(0);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id } })).status).toBe('FAILED');
  });

  it('approval by WhatsApp code executes and records the channel; wrong codes count', async () => {
    const h = await hotel();
    const id = await pendingRequest(h);
    // The route checks codes with the app's secret, so the code is issued with it too.
    let code = '';
    await issueApprovalOtp(
      db,
      {
        otpSecret: TEST_CONFIG.sessionSecret,
        channel: { send: (m) => Promise.resolve(void (code = m.code)) },
      },
      id,
    );
    expect(code).toMatch(/^\d{6}$/);
    const gm = await h.as(h.gm.id);
    const wrong = code === '000000' ? '111111' : '000000';
    const bad = await gm.post(`/approvals/${id}/approve`, { otp: wrong });
    expect(bad.status).toBe(400);
    expect((await db.approvalRequest.findUniqueOrThrow({ where: { id } })).otpAttempts).toBe(1);
    await gm.post(`/approvals/${id}/approve`, { otp: code }).expect(200);
    expect(await db.approvalRequest.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'EXECUTED',
      decisionChannel: 'WHATSAPP_OTP',
    });
  });
});

describe('the inbox', () => {
  it('approvers see every request with what they may decide; others only their own', async () => {
    const h = await hotel();
    const id = await pendingRequest(h);
    const gmList = await (await h.as(h.gm.id)).get('/approvals?status=PENDING');
    const items = (gmList.body as { data: Item[] }).data;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id,
      action: 'folio.discount',
      payload: { bps: 2000 },
      requestedBy: { id: h.fd.id },
      canDecide: true,
    });
    const fdItems = ((await (await h.as(h.fd.id)).get('/approvals')).body as { data: Item[] }).data;
    expect(fdItems.map((i) => [i.id, i.canDecide])).toEqual([[id, false]]);

    // Someone else's request is invisible to a non-approver.
    const staff = await h.person('staff', h.p1.id);
    const theirs = await (await h.as(staff.id)).get(`/approvals/${id}`);
    expect(theirs.status).toBe(404);
  });
});

describe('policies (M1-12)', () => {
  it('lists every protected action with the defaults of rule 2', async () => {
    const h = await hotel();
    const res = await (await h.as(h.owner.id)).get('/approval-policies');
    const data = (
      res.body as {
        data: {
          action: string;
          thresholdBps: number | null;
          expiryMinutes: number;
          approverRoleIds: string[];
          active: boolean;
        }[];
      }
    ).data;
    expect(data).toHaveLength(10);
    expect(data.every((p) => p.active)).toBe(true);
    expect(data.find((p) => p.action === 'folio.discount')).toMatchObject({
      thresholdBps: 1500,
      expiryMinutes: 30,
    });
    expect(data.find((p) => p.action === 'payment.refund')).toMatchObject({
      thresholdBps: null,
      expiryMinutes: 48 * 60,
    });
    expect(new Set(data[0]?.approverRoleIds)).toEqual(new Set([h.role('owner'), h.role('gm')]));
  });

  it('only approval.policy.manage holders change them; changes are checked and audited', async () => {
    const h = await hotel();
    const policy = (over: object) => ({
      action: 'folio.discount',
      active: true,
      thresholdMinor: null,
      thresholdBps: 2000,
      approverRoleIds: [h.role('owner')],
      expiryMinutes: 15,
      ...over,
    });
    expect(
      (await (await h.as(h.gm.id)).put('/approval-policies', { policies: [policy({})] })).status,
    ).toBe(403);
    const owner = await h.as(h.owner.id);
    const bad = async (over: object) => {
      const res = await owner.put('/approval-policies', { policies: [policy(over)] });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
    };
    await bad({ thresholdMinor: '100' });
    await bad({ approverRoleIds: [h.role('front-desk')] });
    await bad({ approverRoleIds: [] });
    await owner.put('/approval-policies', { policies: [policy({})] }).expect(200);
    const saved = await db.approvalPolicy.findFirstOrThrow({ where: { action: 'folio.discount' } });
    expect(saved).toMatchObject({
      thresholdBps: 2000,
      expiryMinutes: 15,
      approverRoleIds: [h.role('owner')],
    });
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: 'approval_policy.updated' },
    });
    expect(audit).toMatchObject({
      actorUserId: h.owner.id,
      before: { thresholdBps: 1500 },
      after: { thresholdBps: 2000 },
    });
    // The new threshold applies at once.
    expect((await (await h.as(h.fd.id)).post('/test/discounts', discountBody(1800))).status).toBe(
      201,
    );
  });

  it('a new property starts with the default policies at sign-up', async () => {
    const api = authApi(db, clock);
    await api
      .post('/auth/sign-up', {
        name: 'Ada Obi',
        email: 'ada@example.test',
        password: PASSWORD,
        organisationName: 'Obi Hotels',
        country: 'NG',
        propertyName: 'Obi Lagos Suites',
      })
      .expect(201);
    expect(tokenFromEmail(api, 'ada@example.test')).toBeTruthy();
    const policies = await db.approvalPolicy.findMany();
    expect(policies).toHaveLength(10);
    expect(policies.every((p) => p.approverRoleIds.length === 2)).toBe(true);
  });
});
