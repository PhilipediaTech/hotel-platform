import {
  type LimitKind,
  type Role as RoleSchema,
  type StaffUser as StaffUserSchema,
  type PermissionInfo as PermissionInfoSchema,
  type RoleLimitsValue,
} from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ShieldAlert } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../../app/session.ts';
import { Alert } from '../../components/ui/alert.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { Label } from '../../components/ui/label.tsx';
import { api } from '../../lib/api.ts';
import { cn } from '../../lib/cn.ts';
import { errorMessage } from '../../lib/form.ts';
import { ApprovalPoliciesTab } from './approval-policies.tsx';

// S26 Users and roles (PRD M1-04, M1-05; T-013): people with a role in this property,
// pending invitations, and the organisation's roles. The server enforces every rule; the
// screen only hides what the user can't do.

type Role = z.output<typeof RoleSchema>;
type StaffUser = z.output<typeof StaffUserSchema>;
type PermissionInfo = z.output<typeof PermissionInfoSchema>;

function useHas() {
  const { permissions } = useSession();
  return useMemo(() => {
    const held = new Set(permissions);
    return {
      has: (code: string) => held.has(code),
      /** No escalation: only roles whose every permission I hold. */
      canGive: (role: Pick<Role, 'permissions'>) => role.permissions.every((c) => held.has(c)),
    };
  }, [permissions]);
}

function useAccessKey(...parts: string[]) {
  const { currentPropertyId } = useSession();
  return ['access', currentPropertyId ?? '', ...parts];
}

function useRoles(enabled = true) {
  return useQuery({
    queryKey: useAccessKey('roles'),
    queryFn: async () => (await api.call('listRoles')).data,
    enabled,
  });
}

function CopyLink({ link }: { link: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 flex items-center gap-2">
      <Input
        readOnly
        value={link}
        aria-label={t('access.oneTimeLink')}
        className="font-mono text-xs"
      />
      <Button
        size="sm"
        variant="secondary"
        onClick={() => {
          void navigator.clipboard?.writeText(link).then(
            () => setCopied(true),
            () => setCopied(false),
          );
        }}
      >
        <Copy aria-hidden className="size-4" />
        {copied ? t('access.copied') : t('access.copy')}
      </Button>
    </div>
  );
}

export function UsersAndRolesPage() {
  const { t } = useTranslation();
  const { has } = useHas();
  const tabs = [
    ...(has('role.assign') ? (['people'] as const) : []),
    ...(has('user.invite') ? (['invitations'] as const) : []),
    ...(has('role.assign') ? (['roles'] as const) : []),
    ...(has('approval.policy.manage') ? (['policies'] as const) : []),
  ];
  const [tab, setTab] = useState<(typeof tabs)[number] | undefined>(tabs[0]);

  return (
    <section>
      <h1 className="text-xl font-semibold">{t('access.title')}</h1>
      <div
        role="tablist"
        aria-label={t('access.title')}
        className="mt-4 flex gap-1 border-b border-border"
      >
        {tabs.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            onClick={() => setTab(name)}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm',
              tab === name
                ? 'border-brand font-semibold text-brand-strong'
                : 'border-transparent text-text-muted',
            )}
          >
            {t(`access.tabs.${name}`)}
          </button>
        ))}
      </div>
      <div role="tabpanel" className="mt-4">
        {tab === 'people' && <PeopleTab />}
        {tab === 'invitations' && <InvitationsTab />}
        {tab === 'roles' && <RolesTab />}
        {tab === 'policies' && <ApprovalPoliciesTab />}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------
// People

function PeopleTab() {
  const { t } = useTranslation();
  const users = useQuery({
    queryKey: useAccessKey('users'),
    queryFn: () => api.call('listUsers', { query: { limit: 200 } }),
  });
  const roles = useRoles();
  const [open, setOpen] = useState<string | null>(null);

  if (users.error) return <Alert tone="critical">{errorMessage(users.error)}</Alert>;
  if (!users.data || !roles.data)
    return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;

  return (
    <ul className="divide-y divide-border rounded-md border border-border bg-surface">
      {users.data.data.map((user) => (
        <li key={user.id} className="p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {user.name}
                {user.status === 'DISABLED' && (
                  <span className="ml-2 rounded bg-critical-subtle px-1.5 py-0.5 text-xs text-critical">
                    {t('access.disabled')}
                  </span>
                )}
              </p>
              <p className="text-sm text-text-muted">{user.email ?? user.phone}</p>
              <p className="mt-1 flex flex-wrap gap-1 text-xs">
                {user.roles.map((r) => (
                  <span key={r.membershipId} className="rounded bg-surface-muted px-1.5 py-0.5">
                    {r.roleName}
                    {r.scope === 'ORGANISATION' ? ` · ${t('access.allProperties')}` : ''}
                  </span>
                ))}
              </p>
            </div>
            {user.canManage && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setOpen(open === user.id ? null : user.id)}
              >
                {t('access.manage')}
              </Button>
            )}
          </div>
          {open === user.id && <ManageUser user={user} roles={roles.data} />}
        </li>
      ))}
    </ul>
  );
}

function ManageUser({ user, roles }: { user: StaffUser; roles: Role[] }) {
  const { t } = useTranslation();
  const { has, canGive } = useHas();
  const queryClient = useQueryClient();
  const usersKey = useAccessKey('users');
  const scoped = (scope: 'PROPERTY' | 'ORGANISATION') =>
    user.roles.filter((r) => r.scope === scope).map((r) => r.roleId);
  const [roleIds, setRoleIds] = useState(() => scoped('PROPERTY'));
  const [orgRoleIds, setOrgRoleIds] = useState(() => scoped('ORGANISATION'));
  const [confirmMfa, setConfirmMfa] = useState(false);

  const update = useMutation({
    mutationFn: (body: Parameters<typeof api.call<'updateUser'>>[1]['body']) =>
      api.call('updateUser', { params: { userId: user.id }, body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: usersKey }),
  });
  const resetLink = useMutation({
    mutationFn: () => api.call('createPasswordResetLink', { params: { userId: user.id } }),
  });

  const toggle = (list: string[], set: (v: string[]) => void, id: string) =>
    set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const error = update.error ?? resetLink.error;

  const roleBoxes = (list: string[], set: (v: string[]) => void, legend: string) => (
    <fieldset className="mb-3">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="grid gap-1 sm:grid-cols-2">
        {roles.map((role) => (
          <label key={role.id} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4"
              checked={list.includes(role.id)}
              disabled={!canGive(role)}
              onChange={() => toggle(list, set, role.id)}
            />
            {role.name}
          </label>
        ))}
      </div>
    </fieldset>
  );

  return (
    <div className="mt-3 rounded-md bg-surface-muted p-3">
      {roleBoxes(roleIds, setRoleIds, t('access.rolesHere'))}
      {has('role.manage') && roleBoxes(orgRoleIds, setOrgRoleIds, t('access.rolesEverywhere'))}
      {error && (
        <Alert tone="critical" className="mb-3">
          {errorMessage(error)}
        </Alert>
      )}
      {update.isSuccess && (
        <Alert tone="success" className="mb-3">
          {t('access.saved')}
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={update.isPending}
          onClick={() => update.mutate(has('role.manage') ? { roleIds, orgRoleIds } : { roleIds })}
        >
          {t('access.saveRoles')}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={update.isPending}
          onClick={() =>
            update.mutate({ status: user.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED' })
          }
        >
          {user.status === 'DISABLED' ? t('access.enable') : t('access.disable')}
        </Button>
        {user.mfaEnabled && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => (confirmMfa ? update.mutate({ resetMfa: true }) : setConfirmMfa(true))}
          >
            <ShieldAlert aria-hidden className="size-4" />
            {confirmMfa ? t('access.confirmResetMfa') : t('access.resetMfa')}
          </Button>
        )}
        <Button size="sm" variant="secondary" onClick={() => resetLink.mutate()}>
          {t('access.resetLink')}
        </Button>
      </div>
      {resetLink.data && (
        <p className="mt-3 text-sm">
          {t('access.resetLinkReady')}
          <CopyLink link={resetLink.data.link} />
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Invitations

function InvitationsTab() {
  const { t } = useTranslation();
  const { has, canGive } = useHas();
  const queryClient = useQueryClient();
  const key = useAccessKey('invitations');
  const invitations = useQuery({
    queryKey: key,
    queryFn: async () => (await api.call('listInvitations')).data,
  });
  const roles = useRoles(has('role.assign'));
  const [contactKind, setContactKind] = useState<'email' | 'phone'>('email');
  const [contact, setContact] = useState('');
  const [roleId, setRoleId] = useState('');
  const [everywhere, setEverywhere] = useState(false);

  const invite = useMutation({
    mutationFn: () =>
      api.call('createInvitation', {
        body: {
          ...(contactKind === 'email' ? { email: contact } : { phone: contact }),
          roleId,
          scope: everywhere ? 'ORGANISATION' : 'PROPERTY',
        },
      }),
    onSuccess: () => {
      setContact('');
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const revoke = useMutation({
    mutationFn: (invitationId: string) =>
      api.call('revokeInvitation', { params: { invitationId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const assignable = (roles.data ?? []).filter(canGive);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form
        className="rounded-md border border-border bg-surface p-4"
        onSubmit={(event) => {
          event.preventDefault();
          invite.mutate();
        }}
      >
        <h2 className="mb-3 font-semibold">{t('access.invite')}</h2>
        <fieldset className="mb-3 flex gap-4 text-sm">
          <legend className="sr-only">{t('access.contactKind')}</legend>
          {(['email', 'phone'] as const).map((kind) => (
            <label key={kind} className="flex items-center gap-2">
              <input
                type="radio"
                name="contactKind"
                checked={contactKind === kind}
                onChange={() => setContactKind(kind)}
              />
              {t(`access.by.${kind}`)}
            </label>
          ))}
        </fieldset>
        <div className="mb-3 flex flex-col gap-1">
          <Label htmlFor="invite-contact">{t(`access.contact.${contactKind}`)}</Label>
          <Input
            id="invite-contact"
            type={contactKind === 'email' ? 'email' : 'tel'}
            value={contact}
            onChange={(e) => setContact(e.target.value)}
          />
        </div>
        <div className="mb-3 flex flex-col gap-1">
          <Label htmlFor="invite-role">{t('access.role')}</Label>
          <select
            id="invite-role"
            className="h-10 rounded-md border border-border bg-surface px-3 text-sm"
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
          >
            <option value="">{t('access.chooseRole')}</option>
            {assignable.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </select>
        </div>
        {has('role.manage') && (
          <label className="mb-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={everywhere}
              onChange={(e) => setEverywhere(e.target.checked)}
            />
            {t('access.everyProperty')}
          </label>
        )}
        {invite.error && (
          <Alert tone="critical" className="mb-3">
            {errorMessage(invite.error)}
          </Alert>
        )}
        {invite.data && (
          <Alert tone="success" className="mb-3">
            {invite.data.link ? (
              <>
                {t('access.phoneInviteReady')}
                <CopyLink link={invite.data.link} />
              </>
            ) : (
              t('access.emailInviteSent')
            )}
          </Alert>
        )}
        <Button type="submit" disabled={invite.isPending || !contact || !roleId}>
          {t('access.sendInvite')}
        </Button>
      </form>

      <div>
        <h2 className="mb-3 font-semibold">{t('access.pending')}</h2>
        {invitations.data?.length === 0 && (
          <p className="text-sm text-text-muted">{t('access.noPending')}</p>
        )}
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {invitations.data?.map((inv) => (
            <li key={inv.id} className="flex items-center gap-2 p-3 text-sm">
              <div className="flex-1">
                <p className="font-medium">{inv.email ?? inv.phone}</p>
                <p className="text-text-muted">
                  {inv.roleName}
                  {inv.scope === 'ORGANISATION' ? ` · ${t('access.allProperties')}` : ''}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => revoke.mutate(inv.id)}>
                {t('access.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Roles

function RolesTab() {
  const { t } = useTranslation();
  const { has } = useHas();
  const roles = useRoles();
  const catalogue = useQuery({
    queryKey: ['permissions'],
    queryFn: async () => (await api.call('listPermissions')).data,
    staleTime: Infinity,
  });
  const [editing, setEditing] = useState<Role | 'new' | null>(null);

  if (roles.error) return <Alert tone="critical">{errorMessage(roles.error)}</Alert>;
  if (!roles.data || !catalogue.data)
    return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  const canEdit = has('role.manage');

  return (
    <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
      <div>
        <ul className="divide-y divide-border rounded-md border border-border bg-surface">
          {roles.data.map((role) => (
            <li key={role.id}>
              <button
                type="button"
                className={cn(
                  'flex w-full items-center justify-between p-3 text-left text-sm',
                  editing !== 'new' && editing?.id === role.id && 'bg-brand-subtle',
                )}
                onClick={() => setEditing(role)}
              >
                <span>{role.name}</span>
                <span className="text-text-muted">
                  {t('access.people', { count: role.memberCount })}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {canEdit && (
          <Button className="mt-3" size="sm" variant="secondary" onClick={() => setEditing('new')}>
            {t('access.newRole')}
          </Button>
        )}
      </div>
      {editing && (
        <RoleEditor
          key={editing === 'new' ? 'new' : editing.id}
          role={editing === 'new' ? null : editing}
          catalogue={catalogue.data}
          readOnly={!canEdit}
          onSaved={(role) => setEditing(role)}
        />
      )}
    </div>
  );
}

const LIMIT_FIELDS: Record<
  LimitKind,
  { field: 'maxAmountMinor' | 'maxBps' | 'maxCount'; scale: number }
> = {
  // Amounts are typed in major units (₦); all sign-up currencies have 2 decimals.
  amount: { field: 'maxAmountMinor', scale: 100 },
  percent: { field: 'maxBps', scale: 100 },
  count: { field: 'maxCount', scale: 1 },
};

function limitInput(limits: RoleLimitsValue, code: string, kind: LimitKind): string {
  const { field, scale } = LIMIT_FIELDS[kind];
  const value = limits[code]?.[field];
  return value === undefined ? '' : String(Number(value) / scale);
}

function RoleEditor({
  role,
  catalogue,
  readOnly,
  onSaved,
}: {
  role: Role | null;
  catalogue: PermissionInfo[];
  readOnly: boolean;
  onSaved: (role: Role) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const rolesKey = useAccessKey('roles');
  const [name, setName] = useState(role?.name ?? '');
  const [requiresMfa, setRequiresMfa] = useState(role?.requiresMfa ?? false);
  const [codes, setCodes] = useState(() => new Set(role?.permissions ?? []));
  const [limits, setLimits] = useState<RoleLimitsValue>(() => role?.limits ?? {});

  const save = useMutation({
    mutationFn: () => {
      const permissions = [...codes];
      const kept = Object.fromEntries(Object.entries(limits).filter(([code]) => codes.has(code)));
      const body = { name, permissions, limits: kept, requiresMfa };
      return role
        ? api.call('updateRole', { params: { roleId: role.id }, body })
        : api.call('createRole', { body });
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: rolesKey });
      onSaved(saved);
    },
  });

  const groups = useMemo(() => {
    const map = new Map<string, PermissionInfo[]>();
    for (const p of catalogue) map.set(p.group, [...(map.get(p.group) ?? []), p]);
    return [...map.entries()];
  }, [catalogue]);

  const setLimit = (code: string, kind: LimitKind, text: string) => {
    const { field, scale } = LIMIT_FIELDS[kind];
    setLimits((prev) => {
      const next = { ...prev[code] };
      if (text.trim() === '') delete next[field];
      else {
        const n = Math.round(Number(text) * scale);
        if (field === 'maxAmountMinor') next.maxAmountMinor = String(n);
        else next[field] = n;
      }
      const all = { ...prev };
      if (Object.keys(next).length === 0) delete all[code];
      else all[code] = next;
      return all;
    });
  };

  return (
    <form
      className="rounded-md border border-border bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="mb-3 flex flex-col gap-1">
        <Label htmlFor="role-name">{t('access.roleName')}</Label>
        <Input
          id="role-name"
          value={name}
          disabled={readOnly || role?.isSystem}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <label className="mb-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={requiresMfa}
          disabled={readOnly}
          onChange={(e) => setRequiresMfa(e.target.checked)}
        />
        {t('access.requiresMfa')}
      </label>

      {groups.map(([group, perms]) => (
        <fieldset key={group} className="mb-4">
          <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t(`access.groups.${group}`)}
          </legend>
          {perms.map((p) => (
            <Row key={p.code}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={codes.has(p.code)}
                  disabled={readOnly}
                  onChange={() =>
                    setCodes((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.code)) next.delete(p.code);
                      else next.add(p.code);
                      return next;
                    })
                  }
                />
                <span>{p.label}</span>
                <code className="text-xs text-text-muted">{p.code}</code>
              </label>
              {codes.has(p.code) &&
                p.limits.map((kind) => (
                  <label key={kind} className="ml-6 mt-1 flex items-center gap-2 text-xs">
                    {t(`access.limit.${kind}`)}
                    <Input
                      inputMode="decimal"
                      className="h-8 w-28"
                      disabled={readOnly}
                      aria-label={`${p.label}: ${t(`access.limit.${kind}`)}`}
                      value={limitInput(limits, p.code, kind)}
                      onChange={(e) => setLimit(p.code, kind, e.target.value)}
                    />
                  </label>
                ))}
            </Row>
          ))}
        </fieldset>
      ))}

      {save.error && (
        <Alert tone="critical" className="mb-3">
          {errorMessage(save.error)}
        </Alert>
      )}
      {!readOnly && (
        <Button type="submit" disabled={save.isPending || !name.trim()}>
          {role ? t('access.saveRole') : t('access.createRole')}
        </Button>
      )}
    </form>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="py-1">{children}</div>;
}
