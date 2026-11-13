import type { TaskDetail, WorkOrderBody, WorkOrderItem } from '@hotel/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import maintenanceStrings from '../i18n/en/maintenance.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(maintenanceStrings);

// Work order on the task page (PRD M5-08; T-130): the parts, labour time and outside cost
// logged on a job, and the asset it is on. States and after photos stay with the task actions.

type Detail = z.output<typeof TaskDetail>;
type WorkOrder = z.output<typeof WorkOrderItem>;
type PartDraft = { name: string; quantity: string; cost: string };

const selectClass = 'h-11 rounded-md border border-border bg-surface px-3 text-sm';

/** "1,500.50" → "150050"; blank is zero; null when it is not an amount. */
export function amountToMinor(text: string): string | null {
  const clean = text.replace(/[,\s₦]/g, '');
  if (clean === '') return '0';
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole = '0', fraction = ''] = clean.split('.');
  return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))).toString();
}
const toText = (minor: string) => (Number(minor) / 100).toFixed(2);

export function hoursAndMinutes(t: ReturnType<typeof useTranslation>['t'], minutes: number) {
  return t('mnt.wo.time', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

export function WorkOrderPanel(props: { task: Detail; onSaved: () => void }) {
  const { t } = useTranslation();
  const f = useFormats();
  const [editing, setEditing] = useState(false);
  const { task } = props;
  const wo = task.workOrder;
  if (!wo && !task.canLogWork && !task.asset) return null;
  return (
    <section aria-labelledby="wo-title" className="mt-6 rounded-md border border-border p-3">
      <h2 id="wo-title" className="text-base font-semibold">
        {t('mnt.wo.title')}
      </h2>
      {task.asset && (
        <p className="mt-1 text-sm">
          {t('mnt.wo.asset')}:{' '}
          <Link to={`/maintenance?asset=${task.asset.id}`} className="text-brand underline">
            {task.asset.tag} · {task.asset.name}
          </Link>
        </p>
      )}
      {wo ? (
        <WorkOrderSummary wo={wo} money={f.money} />
      ) : (
        <p className="mt-1 text-sm text-text-muted">{t('mnt.wo.none')}</p>
      )}
      {task.canLogWork &&
        (editing ? (
          <WorkOrderForm
            task={task}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              props.onSaved();
            }}
          />
        ) : (
          <Button variant="secondary" className="mt-2 h-11" onClick={() => setEditing(true)}>
            {wo ? t('mnt.wo.edit') : t('mnt.wo.log')}
          </Button>
        ))}
    </section>
  );
}

function WorkOrderSummary({ wo, money }: { wo: WorkOrder; money: (m: string) => string }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 text-sm">
      {wo.parts.length > 0 && (
        <ul aria-label={t('mnt.wo.parts')} className="flex flex-col gap-0.5">
          {wo.parts.map((p, i) => (
            <li key={`${p.name}-${i}`}>
              {p.quantity} × {p.name} · {money(p.costMinor)}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1">
        {t('mnt.wo.labour')}: {hoursAndMinutes(t, wo.labourMinutes)}
      </p>
      {wo.vendorName && (
        <p>
          {t('mnt.wo.vendor')}: {wo.vendorName} · {money(wo.vendorCostMinor)}
        </p>
      )}
      <p className="font-medium">{t('mnt.wo.totalCost', { amount: money(wo.costMinor) })}</p>
    </div>
  );
}

function WorkOrderForm(props: { task: Detail; onCancel: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const { permissions } = useSession();
  const wo = props.task.workOrder;
  const [parts, setParts] = useState<PartDraft[]>(
    wo?.parts.map((p) => ({
      name: p.name,
      quantity: String(p.quantity),
      cost: toText(p.costMinor),
    })) ?? [],
  );
  const [hours, setHours] = useState(String(Math.floor((wo?.labourMinutes ?? 0) / 60)));
  const [minutes, setMinutes] = useState(String((wo?.labourMinutes ?? 0) % 60));
  const [vendor, setVendor] = useState(wo?.vendorName ?? '');
  const [vendorCost, setVendorCost] = useState(wo ? toText(wo.vendorCostMinor) : '');
  const [assetId, setAssetId] = useState(props.task.asset?.id ?? '');
  const canPickAsset = permissions.includes('asset.manage') || permissions.includes('wo.work');
  const assets = useQuery({
    queryKey: ['assets', 'pick'],
    queryFn: () => api.call('listAssets', { query: {} }),
    enabled: canPickAsset,
  });
  const save = useMutation({
    mutationFn: (body: z.input<typeof WorkOrderBody>) =>
      api.call('saveWorkOrder', { params: { taskId: props.task.id }, body }),
    onSuccess: props.onSaved,
  });
  const [problem, setProblem] = useState<string | null>(null);
  const setPart = (i: number, change: Partial<PartDraft>) =>
    setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...change } : p)));
  const submit = () => {
    const cleanParts = parts.filter((p) => p.name.trim() !== '');
    const outParts: { name: string; quantity: number; costMinor: string }[] = [];
    for (const p of cleanParts) {
      const quantity = Number(p.quantity);
      const cost = amountToMinor(p.cost);
      if (!Number.isInteger(quantity) || quantity < 1 || cost === null) {
        setProblem(t('mnt.wo.badPart', { name: p.name.trim() }));
        return;
      }
      outParts.push({ name: p.name.trim(), quantity, costMinor: cost });
    }
    const h = Number(hours || '0');
    const m = Number(minutes || '0');
    const vc = amountToMinor(vendorCost);
    if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) {
      setProblem(t('mnt.wo.badTime'));
      return;
    }
    if (vc === null) {
      setProblem(t('mnt.wo.badAmount'));
      return;
    }
    setProblem(null);
    save.mutate({
      parts: outParts,
      labourMinutes: h * 60 + m,
      vendorName: vendor.trim() === '' ? null : vendor.trim(),
      vendorCostMinor: vc,
      ...(canPickAsset ? { assetId: assetId || null } : {}),
    });
  };
  return (
    <form
      aria-label={t('mnt.wo.form')}
      className="mt-3 flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {canPickAsset && assets.data && (
        <div className="flex flex-col gap-1">
          <Label htmlFor="wo-asset">{t('mnt.wo.asset')}</Label>
          <select
            id="wo-asset"
            className={selectClass}
            value={assetId}
            onChange={(e) => setAssetId(e.target.value)}
          >
            <option value="">{t('mnt.wo.noAsset')}</option>
            {assets.data.data
              .filter((a) => a.status !== 'RETIRED' || a.id === props.task.asset?.id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.tag} · {a.name}
                </option>
              ))}
          </select>
        </div>
      )}
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('mnt.wo.parts')}</legend>
        {parts.map((p, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`part-${i}`}>{t('mnt.wo.partName')}</Label>
              <Input
                id={`part-${i}`}
                value={p.name}
                onChange={(e) => setPart(i, { name: e.target.value })}
              />
            </div>
            <div className="flex w-20 flex-col gap-1">
              <Label htmlFor={`part-q-${i}`}>{t('mnt.wo.quantity')}</Label>
              <Input
                id={`part-q-${i}`}
                inputMode="numeric"
                value={p.quantity}
                onChange={(e) => setPart(i, { quantity: e.target.value })}
              />
            </div>
            <div className="flex w-32 flex-col gap-1">
              <Label htmlFor={`part-c-${i}`}>{t('mnt.wo.partCost')}</Label>
              <Input
                id={`part-c-${i}`}
                inputMode="decimal"
                value={p.cost}
                onChange={(e) => setPart(i, { cost: e.target.value })}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              className="h-11"
              aria-label={t('mnt.wo.removePart', { n: i + 1 })}
              onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}
            >
              {t('mnt.wo.remove')}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="secondary"
          className="h-11 self-start"
          onClick={() => setParts((ps) => [...ps, { name: '', quantity: '1', cost: '' }])}
        >
          {t('mnt.wo.addPart')}
        </Button>
      </fieldset>
      <fieldset className="flex flex-wrap items-end gap-2">
        <legend className="text-sm font-medium">{t('mnt.wo.labour')}</legend>
        <div className="flex w-20 flex-col gap-1">
          <Label htmlFor="wo-hours">{t('mnt.wo.hours')}</Label>
          <Input
            id="wo-hours"
            inputMode="numeric"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </div>
        <div className="flex w-20 flex-col gap-1">
          <Label htmlFor="wo-minutes">{t('mnt.wo.minutes')}</Label>
          <Input
            id="wo-minutes"
            inputMode="numeric"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
          />
        </div>
      </fieldset>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="wo-vendor">{t('mnt.wo.vendorName')}</Label>
          <Input id="wo-vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} />
        </div>
        <div className="flex w-36 flex-col gap-1">
          <Label htmlFor="wo-vendor-cost">{t('mnt.wo.vendorCost')}</Label>
          <Input
            id="wo-vendor-cost"
            inputMode="decimal"
            value={vendorCost}
            onChange={(e) => setVendorCost(e.target.value)}
          />
        </div>
      </div>
      {problem && <Alert tone="critical">{problem}</Alert>}
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" className="h-11" disabled={save.isPending}>
          {t('mnt.wo.save')}
        </Button>
        <Button type="button" variant="ghost" className="h-11" onClick={props.onCancel}>
          {t('mnt.cancel')}
        </Button>
      </div>
    </form>
  );
}
