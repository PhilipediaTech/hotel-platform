import type { MaintenanceInsight } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import maintenanceStrings from '../i18n/en/maintenance.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';

registerStrings(maintenanceStrings);

// S34 Insights (Versions V3 "maintenance anomaly insights"; T-180): what is out of pattern,
// worked out by rules. "Create task" opens the new-task form filled in, for staff to check;
// "Dismiss" asks why, and the reason is kept.

type Insight = z.output<typeof MaintenanceInsight>;

const units = (n: number, scale: number) =>
  (n / scale).toLocaleString(undefined, { maximumFractionDigits: 2 });

function useText() {
  const { t } = useTranslation();
  return (i: Insight) => {
    switch (i.kind) {
      case 'REPEAT_FAULTS':
        return t('mnt.insights.REPEAT_FAULTS', { count: i.value });
      case 'REOPENED_FAULT':
        return t('mnt.insights.REOPENED_FAULT', { count: i.value });
      case 'METER_USE':
        return t('mnt.insights.METER_USE', {
          value: units(i.value, 100),
          usual: units(i.usual ?? 0, 100),
        });
      case 'GENERATOR_FUEL':
        return t('mnt.insights.GENERATOR_FUEL', {
          value: units(i.value, 1000),
          usual: units(i.usual ?? 0, 1000),
        });
    }
  };
}

function Card({ insight, onDismissed }: { insight: Insight; onDismissed: () => void }) {
  const { t } = useTranslation();
  const text = useText();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const dismiss = useMutation({
    mutationFn: () =>
      api.call('dismissMaintenanceInsight', {
        body: { key: insight.key, fingerprint: insight.fingerprint, reason: reason.trim() },
      }),
    onSuccess: onDismissed,
  });
  const what = text(insight);
  const task = new URLSearchParams({
    type: 'FAULT',
    ...(insight.roomId ? { roomId: insight.roomId } : {}),
    description: `${insight.subject.label}: ${what}`,
  });
  const reasonId = `insight-reason-${insight.key}`;
  return (
    <li className="rounded-md border border-border bg-surface p-3 text-sm">
      <p className="font-medium">
        {insight.subject.label}
        {insight.severity === 'HIGH' && (
          <span className="ml-2 text-xs text-critical">{t('mnt.insights.high')}</span>
        )}
      </p>
      <p>{what}</p>
      {insight.overduePlans > 0 && (
        <p className="text-critical">
          {t('mnt.insights.overdue', { count: insight.overduePlans })}
        </p>
      )}
      {insight.taskIds.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-2">
          {insight.taskIds.slice(0, 5).map((id, n) => (
            <Link key={id} to={`/tasks/${id}`} className="text-brand underline">
              {t('mnt.insights.fault', { n: n + 1 })}
            </Link>
          ))}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <Link to={`/tasks/new?${task.toString()}`} className="text-brand underline">
          {t('mnt.insights.createTask')}
        </Link>
        {!asking && (
          <Button size="sm" variant="secondary" onClick={() => setAsking(true)}>
            {t('mnt.insights.dismiss')}
          </Button>
        )}
      </div>
      {asking && (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim().length >= 3) dismiss.mutate();
          }}
        >
          <Label htmlFor={reasonId}>{t('mnt.insights.reason')}</Label>
          <Input
            id={reasonId}
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={dismiss.isPending || reason.trim().length < 3}
            >
              {t('mnt.insights.confirmDismiss')}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setAsking(false)}>
              {t('mnt.cancel')}
            </Button>
          </div>
          {dismiss.error && <Alert tone="critical">{errorMessage(dismiss.error)}</Alert>}
        </form>
      )}
    </li>
  );
}

export function InsightsView() {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const queryClient = useQueryClient();
  const key = ['maintenance', currentPropertyId ?? '', 'insights'];
  const q = useQuery({ queryKey: key, queryFn: () => api.call('listMaintenanceInsights') });
  return (
    <div className="mt-4">
      <p className="text-sm text-text-muted">{t('mnt.insights.hint')}</p>
      {q.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(q.error)}
        </Alert>
      )}
      {q.data && q.data.data.length === 0 && (
        <p className="mt-3 text-sm">{t('mnt.insights.none')}</p>
      )}
      <ul aria-label={t('mnt.insights.list')} className="mt-3 flex flex-col gap-2">
        {q.data?.data.map((i) => (
          <Card
            key={`${i.key}|${i.fingerprint}`}
            insight={i}
            onDismissed={() => void queryClient.invalidateQueries({ queryKey: key })}
          />
        ))}
      </ul>
      {q.data && q.data.dismissed > 0 && (
        <p className="mt-3 text-xs text-text-muted">
          {t('mnt.insights.dismissed', { count: q.data.dismissed })}
        </p>
      )}
    </div>
  );
}
