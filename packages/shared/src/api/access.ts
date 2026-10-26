import { z } from 'zod';
import { HotelPermission, RoleLimits } from '../permissions.ts';
import { Email, Password, Phone } from './auth.ts';
import { defineRoute } from './contract.ts';
import { Instant, page, PageQuery, Uuid } from './primitives.ts';

// Users and roles (tab 4 row "Users and roles"; PRD M1-04, M1-05; S26). All management
// routes act in the property named by X-Property-Id: roles belong to its organisation,
// users are those with a role there (property or organisation-wide). T-013.

const ROLE_ASSIGN = 'role.assign';
const ROLE_MANAGE = 'role.manage';
const USER_INVITE = 'user.invite';

export const PermissionInfo = z
  .object({
    code: z.string(),
    group: z.string(),
    label: z.string(),
    limits: z.array(z.enum(['amount', 'percent', 'count'])),
  })
  .meta({ id: 'PermissionInfo' });

export const listPermissions = defineRoute({
  operationId: 'listPermissions',
  method: 'get',
  path: '/permissions',
  summary: 'The permission catalogue a hotel role can hold',
  tags: ['Users and roles'],
  response: z.object({ data: z.array(PermissionInfo) }),
});

export const Role = z
  .object({
    id: Uuid,
    name: z.string(),
    /** Templates every organisation starts with; their names can't change. */
    isSystem: z.boolean(),
    requiresMfa: z.boolean(),
    permissions: z.array(z.string()),
    limits: RoleLimits,
    /** People holding the role anywhere in the organisation. */
    memberCount: z.number().int(),
  })
  .meta({ id: 'Role' });

export const listRoles = defineRoute({
  operationId: 'listRoles',
  method: 'get',
  path: '/roles',
  summary: 'Roles of the organisation',
  tags: ['Users and roles'],
  propertyScoped: true,
  permission: ROLE_ASSIGN,
  response: z.object({ data: z.array(Role) }),
});

const RoleName = z.string().trim().min(1).max(60);
const PermissionList = z
  .array(HotelPermission)
  .max(200)
  .refine((codes) => new Set(codes).size === codes.length, 'Each permission once');

const RoleFields = z.object({
  name: RoleName,
  permissions: PermissionList,
  limits: RoleLimits,
  requiresMfa: z.boolean(),
});

export const RoleBody = RoleFields.extend({
  limits: RoleLimits.default({}),
  requiresMfa: z.boolean().default(false),
});

/**
 * Edits: built from the fields without defaults, because Zod's `.partial()` keeps defaults
 * and an omitted `requiresMfa` would silently become false.
 */
export const RolePatchBody = RoleFields.partial();

export const createRole = defineRoute({
  operationId: 'createRole',
  method: 'post',
  path: '/roles',
  summary: 'Create a role',
  tags: ['Users and roles'],
  propertyScoped: true,
  permission: ROLE_MANAGE,
  body: RoleBody,
  status: 201,
  response: Role,
});

export const updateRole = defineRoute({
  operationId: 'updateRole',
  method: 'patch',
  path: '/roles/{roleId}',
  summary: 'Edit a role: permissions, limits, MFA (and the name of custom roles)',
  description:
    'Changes apply to everyone holding the role from their next request; a new MFA requirement from their next sign-in. The Owner role always keeps role.manage, role.assign and user.invite and always requires MFA.',
  tags: ['Users and roles'],
  propertyScoped: true,
  permission: ROLE_MANAGE,
  params: z.object({ roleId: Uuid }),
  body: RolePatchBody,
  response: Role,
  errors: ['STATE_TRANSITION_INVALID'],
});

const RoleGrant = z.object({
  membershipId: Uuid,
  roleId: Uuid,
  roleName: z.string(),
  /** PROPERTY = this property; ORGANISATION = every property of the organisation. */
  scope: z.enum(['PROPERTY', 'ORGANISATION']),
});

export const StaffUser = z
  .object({
    id: Uuid,
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    status: z.enum(['INVITED', 'ACTIVE', 'DISABLED']),
    mfaEnabled: z.boolean(),
    lastLoginAt: Instant.nullable(),
    roles: z.array(RoleGrant),
    /** Whether the caller may change this user (no escalation, never themselves). */
    canManage: z.boolean(),
  })
  .meta({ id: 'StaffUser' });

export const listUsers = defineRoute({
  operationId: 'listUsers',
  method: 'get',
  path: '/users',
  summary: 'Staff with a role in this property',
  tags: ['Users and roles'],
  propertyScoped: true,
  permission: ROLE_ASSIGN,
  query: PageQuery,
  response: page(StaffUser),
});

export const UpdateUserBody = z
  .object({
    /** The user's roles for this property (replaces them). */
    roleIds: z.array(Uuid).max(20).optional(),
    /** Organisation-wide roles (replaces them); needs role.manage. */
    orgRoleIds: z.array(Uuid).max(20).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    /** Turns MFA off so the user sets it up again (lost phone and codes; issue 37). */
    resetMfa: z.literal(true).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Change at least one thing');

export const updateUser = defineRoute({
  operationId: 'updateUser',
  method: 'patch',
  path: '/users/{userId}',
  summary: 'Change a user’s roles here, disable them, or reset their MFA',
  description:
    'You can only give or take roles whose permissions you hold, only change users who hold no permission you lack, and never yourself. Disabling or resetting MFA signs the user out everywhere. Removing a role ends access through it on the next request.',
  tags: ['Users and roles'],
  propertyScoped: true,
  permission: ROLE_ASSIGN,
  params: z.object({ userId: Uuid }),
  body: UpdateUserBody,
  response: StaffUser,
  errors: ['STATE_TRANSITION_INVALID'],
});

export const createPasswordResetLink = defineRoute({
  operationId: 'createPasswordResetLink',
  method: 'post',
  path: '/users/{userId}/password-reset-link',
  summary: 'A one-time password reset link to give a user (e.g. phone-only staff)',
  description:
    'Valid 24 hours, single use; using it signs the user out everywhere. Same rules as changing the user. Spec issue 34.',
  tags: ['Users and roles'],
  propertyScoped: true,
  permission: ROLE_ASSIGN,
  params: z.object({ userId: Uuid }),
  status: 201,
  response: z.object({ link: z.string(), expiresAt: Instant }),
});

export const Invitation = z
  .object({
    id: Uuid,
    email: z.string().nullable(),
    phone: z.string().nullable(),
    roleId: Uuid,
    roleName: z.string(),
    scope: z.enum(['PROPERTY', 'ORGANISATION']),
    invitedBy: z.object({ id: Uuid, name: z.string() }),
    createdAt: Instant,
    expiresAt: Instant,
  })
  .meta({ id: 'Invitation' });

export const listInvitations = defineRoute({
  operationId: 'listInvitations',
  method: 'get',
  path: '/users/invitations',
  summary: 'Pending invitations for this property (and organisation-wide)',
  tags: ['Users and roles'],
  propertyScoped: true,
  permission: USER_INVITE,
  response: z.object({ data: z.array(Invitation) }),
});

export const InvitationBody = z
  .object({
    email: Email.optional(),
    phone: Phone.optional(),
    roleId: Uuid,
    scope: z.enum(['PROPERTY', 'ORGANISATION']).default('PROPERTY'),
  })
  .refine((b) => (b.email === undefined) !== (b.phone === undefined), {
    message: 'Give an email or a phone number',
    path: ['email'],
  });

export const createInvitation = defineRoute({
  operationId: 'createInvitation',
  method: 'post',
  path: '/users/invitations',
  summary: 'Invite someone by email or phone with a role',
  description:
    'Email invitations are emailed. Phone invitations return the one-time link (`link`) for the inviter to share until WhatsApp delivery exists (T-024). Valid 7 days; inviting the same person again replaces the earlier invitation. Organisation-wide invitations need role.manage; the role’s permissions must all be the inviter’s own.',
  tags: ['Users and roles'],
  propertyScoped: true,
  permission: USER_INVITE,
  body: InvitationBody,
  status: 201,
  response: z.object({ invitation: Invitation, link: z.string().nullable() }),
  errors: ['STATE_TRANSITION_INVALID'],
});

export const revokeInvitation = defineRoute({
  operationId: 'revokeInvitation',
  method: 'post',
  path: '/users/invitations/{invitationId}/revoke',
  summary: 'Withdraw a pending invitation',
  tags: ['Users and roles'],
  propertyScoped: true,
  permission: USER_INVITE,
  params: z.object({ invitationId: Uuid }),
  status: 204,
  response: z.void(),
});

const InvitationToken = z.object({ token: z.string().min(20).max(200) });

export const previewInvitation = defineRoute({
  operationId: 'previewInvitation',
  method: 'post',
  path: '/auth/invitations/preview',
  summary: 'What an invitation link is for, before accepting it',
  tags: ['Auth'],
  auth: 'none',
  body: InvitationToken,
  response: z.object({
    organisationName: z.string(),
    propertyName: z.string().nullable(),
    roleName: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    /** True: sign in as that account to accept. False: choose a name and password. */
    accountExists: z.boolean(),
  }),
});

export const acceptInvitation = defineRoute({
  operationId: 'acceptInvitation',
  method: 'post',
  path: '/auth/invitations/accept',
  summary: 'Accept an invitation',
  description:
    'New people send their name and a password, which creates their account (the link proves the email or phone). People who already have an account accept while signed in to it.',
  tags: ['Auth'],
  auth: 'none',
  body: InvitationToken.extend({
    name: z.string().trim().min(1).max(120).optional(),
    password: Password.optional(),
  }),
  status: 204,
  response: z.void(),
  errors: ['UNAUTHENTICATED', 'FORBIDDEN'],
});

export const ACCESS_ROUTES = {
  listPermissions,
  listRoles,
  createRole,
  updateRole,
  listUsers,
  updateUser,
  createPasswordResetLink,
  listInvitations,
  createInvitation,
  revokeInvitation,
  previewInvitation,
  acceptInvitation,
} as const;
