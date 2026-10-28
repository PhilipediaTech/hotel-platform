import { approvalAction, type ApprovalPolicyItem } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { useSession } from '../../app/session.ts';
import { Alert } from '../../components/ui/alert.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Input } from '../../components/ui/input.tsx';
import { api } from '../../lib/api.ts';
import { errorMessage } from '../../lib/form.ts';

// S26 "approval policies" (PRD M1-12; T-022): per protected action, whether it needs
// approval, above what (in ₦ or %), which roles decide, and how long a request waits.

type Policy = z.output<typeof ApprovalPolicyItem>;

/** Thresholds are typed in everyday units: major currency units and whole percent. */
function thresholdText(p: Policy): string {
  if (p.thresholdMinor !== null) return String(Number(p.thresholdMinor) / 100);
  if (p.thresholdBps !== null) return String(p.thresholdBps / 100);
  return '';
}

function withThreshold(p: Policy, text: string): Policy {
  const measure = approvalAction(p.action)?.measure;
  const n = text.trim() === '' ? null : Math.round(Number(text) * 100);
  if (n !== null && (!Number.isFinite(n) || n < 0)) return p;
  if (measure === 'amount') return { ...p, thresholdMinor: n === null ? null : String(n) };
  if (measure === 'percent') return { ...p, thresholdBps: n === null ? null : Math.min(n, 10_000) };
  return p;
}

export function ApprovalPoliciesTab() {
  const { t } = useTranslation();
  const session = useSession();
  const queryClient = useQueryClient();
  const key = ['access', session.currentPropertyId ?? '', 'approval-policies'];
  const policies = useQuery({ queryKey: key, queryFn: () => api.call('listApprovalPolicies') });
  const roles = useQuery({
    queryKey: ['access', session.currentPropertyId ?? '', 'roles'],
    queryFn: async () => (await api.call('listRoles')).data,
  });
  const [draft, setDraft] = useState<Policy[] | null>(null);
  const rows = draft ?? policies.data?.data ?? [];
  const save = useMutation({
    mutationFn: () => api.call('updateApprovalPolicies', { body: { policies: rows } }),
    onSuccess: (saved) => {
      queryClient.setQueryData(key, saved);
      setDraft(null);
    },
  });
  const currency = session.properties.find((p) => p.id === session.currentPropertyId)?.baseCurrency;

  if (policies.error) return <Alert tone="critical">{errorMessage(policies.error)}</Alert>;
  if (!policies.data || !roles.data) {
    return <p className="text-sm text-text-muted">{t('shell.loading')}</p>;
  }
  const approverRoles = roles.data.filter((r) => r.permissions.includes('approval.decide'));
  const update = (action: string, change: (p: Policy) => Policy) =>
    setDraft(rows.map((p) => (p.action === action ? change(p) : p)));

  return (
    <div>
      <p className="mb-3 text-sm text-text-muted">{t('approvals.policies.intro')}</p>
      <ul
        aria-label={t('approvals.policies.tab')}
        className="divide-y divide-border rounded-md border border-border bg-surface"
      >
        {rows.map((p) => {
          const measure = approvalAction(p.action)?.measure;
          const name = t(`approvals.actions.${p.action}`, { defaultValue: p.action });
          return (
            <li key={p.action} className="p-3" aria-label={name}>
              <label className="flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  checked={p.active}
                  onChange={(e) => update(p.action, (x) => ({ ...x, active: e.target.checked }))}
                />
                {name}
              </label>
              {p.active && (
                <div className="mt-2 flex flex-wrap items-end gap-4 text-sm">
                  {(measure === 'amount' || measure === 'percent') && (
                    <label className="flex flex-col gap-1">
                      {t('approvals.policies.threshold')} (
                      {measure === 'amount' ? currency : t('approvals.policies.percent')})
                      <Input
                        className="w-32"
                        inputMode="decimal"
                        placeholder={t('approvals.policies.always')}
                        value={thresholdText(p)}
                        onChange={(e) => update(p.action, (x) => withThreshold(x, e.target.value))}
                      />
                    </label>
                  )}
                  <label className="flex flex-col gap-1">
                    {t('approvals.policies.expiry')}
                    <Input
                      className="w-28"
                      inputMode="numeric"
                      value={String(p.expiryMinutes)}
                      onChange={(e) => {
                        const n = Number(e.target.value.replace(/\D/g, ''));
                        update(p.action, (x) => ({ ...x, expiryMinutes: n }));
                      }}
                    />
                  </label>
                  <fieldset className="flex flex-wrap gap-3">
                    <legend className="mb-1">{t('approvals.policies.approvers')}</legend>
                    {approverRoles.map((role) => (
                      <label key={role.id} className="flex items-center gap-1">
                        <input
                          type="checkbox"
                          checked={p.approverRoleIds.includes(role.id)}
                          onChange={(e) =>
                            update(p.action, (x) => ({
                              ...x,
                              approverRoleIds: e.target.checked
                                ? [...x.approverRoleIds, role.id]
                                : x.approverRoleIds.filter((id) => id !== role.id),
                            }))
                          }
                        />
                        {role.name}
                      </label>
                    ))}
                  </fieldset>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex items-center gap-3">
        <Button disabled={!draft || save.isPending} onClick={() => save.mutate()}>
          {t('approvals.policies.save')}
        </Button>
        {save.isSuccess && !draft && (
          <span className="text-sm">{t('approvals.policies.saved')}</span>
        )}
      </div>
      {save.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(save.error)}
        </Alert>
      )}
    </div>
  );
}
