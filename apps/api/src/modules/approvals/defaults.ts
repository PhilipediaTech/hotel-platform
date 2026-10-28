import { APPROVAL_ACTIONS, defaultExpiryMinutes } from '@hotel/shared';
import type { DbClient } from '../../core/db.ts';
import { OWNER_ROLE_NAME, roleTemplate } from '../identity/role-templates.ts';

/**
 * Creates the default approval policies of a new property (PRD M1 rule 2): every protected
 * action needs approval, discounts above 15%; the Owner and General Manager roles decide;
 * front-desk requests wait 30 minutes, back-office ones 48 hours (rule 3). Existing policies
 * are left alone.
 */
export async function createDefaultApprovalPolicies(
  db: DbClient,
  organisationId: string,
  propertyId: string,
): Promise<void> {
  const approvers = await db.role.findMany({
    where: { organisationId, name: { in: [OWNER_ROLE_NAME, roleTemplate('gm').name] } },
  });
  await db.approvalPolicy.createMany({
    data: APPROVAL_ACTIONS.map((action) => ({
      organisationId,
      propertyId,
      action: action.code,
      thresholdBps: 'defaultThresholdBps' in action ? action.defaultThresholdBps : null,
      approverRoleIds: approvers.map((r) => r.id),
      expiryMinutes: defaultExpiryMinutes(action),
    })),
    skipDuplicates: true,
  });
}
