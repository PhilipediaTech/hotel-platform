import { API_SCOPES, PARTNER_EVENT_TYPES, type ApiScope } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import integrationStrings from '../i18n/en/integrations.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(integrationStrings);

// Integrations (Versions V2 "Partner API and webhooks"; T-166): API keys for outside systems,
// and the URLs the hotel's events are sent to. A key or a signing secret is shown once, when it
// is made; after that only its first characters.

const card = 'rounded-md border border-border bg-surface p-4';
/** i18next reads ':' and '.' in keys as separators. */
const k = (code: string) => code.replace(/[.:]/g, '_');

type Keys = Awaited<ReturnType<typeof listKeys>>;
type ApiKey = Keys['data'][number];
type Endpoints = Awaited<ReturnType<typeof listEndpoints>>;
type Endpoint = Endpoints['data'][number];
type Deliveries = Awaited<ReturnType<typeof listDeliveries>>;
const listKeys = () => api.call('listApiKeys', {});
const listEndpoints = () => api.call('listWebhookEndpoints', {});
const listDeliveries = () => api.call('listWebhookDeliveries', {});

export function IntegrationsPage() {
  const { t } = useTranslation();
  return (
    <section className="max-w-3xl">
      <h1 className="text-xl font-semibold">{t('integrations.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('integrations.intro')}</p>
      <p className="mt-1 text-sm text-text-muted">{t('integrations.docs')}</p>
      <KeysCard />
      <WebhooksCard />
    </section>
  );
}

/** A secret shown once, with a copy button. */
function ShownOnce({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <Alert tone="info" className="mt-3">
      <p>{label}</p>
      <code className="mt-2 block break-all rounded bg-surface-muted p-2 text-sm">{value}</code>
      <div className="mt-2 flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() =>
            void navigator.clipboard
              ?.writeText(value)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }
        >
          {copied ? t('integrations.keys.copied') : t('integrations.keys.copy')}
        </Button>
        <Button size="sm" onClick={onDone}>
          {t('integrations.keys.done')}
        </Button>
      </div>
    </Alert>
  );
}

function KeysCard() {
  const { t } = useTranslation();
  const f = useFormats();
  const { currentPropertyId } = useSession();
  const key = ['api-keys', currentPropertyId ?? ''];
  const keys = useQuery({ queryKey: key, queryFn: listKeys });
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.call('createApiKey', { body: { name: name.trim(), scopes } }),
    onSuccess: (made) => {
      setToken(made.token);
      setName('');
      setScopes([]);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.call('revokeApiKey', { params: { apiKeyId: id } }),
    onSuccess: () => {
      setConfirming(null);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const toggle = (s: ApiScope, on: boolean) =>
    setScopes(on ? [...scopes, s] : scopes.filter((x) => x !== s));
  const scopeNames = (k2: ApiKey) => k2.scopes.map((s) => t(`integrations.scope.${k(s)}`));
  return (
    <div className={`${card} mt-4`}>
      <h2 className="font-semibold">{t('integrations.keys.title')}</h2>
      <p className="mt-1 text-sm text-text-muted">{t('integrations.keys.intro')}</p>
      {token && (
        <ShownOnce
          label={t('integrations.keys.made')}
          value={token}
          onDone={() => setToken(null)}
        />
      )}
      {(keys.error ?? revoke.error) && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(keys.error ?? revoke.error)}
        </Alert>
      )}
      {keys.data?.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('integrations.keys.none')}</p>
      )}
      <ul aria-label={t('integrations.keys.list')} className="mt-3 flex flex-col gap-2">
        {keys.data?.data.map((item) => (
          <li key={item.id} className="rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{item.name}</span>
              {item.revokedAt ? (
                <span className="text-text-muted">
                  {t('integrations.keys.revoked', { when: f.when(item.revokedAt) })}
                </span>
              ) : confirming === item.id ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span>{t('integrations.keys.revokeConfirm', { name: item.name })}</span>
                  <Button size="sm" onClick={() => revoke.mutate(item.id)}>
                    {t('integrations.keys.revokeYes')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    {t('integrations.keys.cancel')}
                  </Button>
                </span>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => setConfirming(item.id)}>
                  {t('integrations.keys.revoke')}
                </Button>
              )}
            </div>
            <p className="text-text-muted">
              {t('integrations.keys.line', {
                prefix: item.prefix,
                by: item.createdBy,
                when: f.when(item.createdAt),
              })}{' '}
              ·{' '}
              {item.lastUsedAt
                ? t('integrations.keys.lastUsed', { when: f.when(item.lastUsedAt) })
                : t('integrations.keys.neverUsed')}
            </p>
            <p>{scopeNames(item).join(', ')}</p>
          </li>
        ))}
      </ul>
      <form
        aria-label={t('integrations.keys.create')}
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div>
          <Label htmlFor="key-name">{t('integrations.keys.name')}</Label>
          <Input
            id="key-name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <fieldset>
          <legend className="text-sm font-medium">{t('integrations.keys.scopes')}</legend>
          {API_SCOPES.map((s) => (
            <label key={s} className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={scopes.includes(s)}
                onChange={(e) => toggle(s, e.target.checked)}
              />
              {t(`integrations.scope.${k(s)}`)}
            </label>
          ))}
        </fieldset>
        {create.error && <Alert tone="critical">{errorMessage(create.error)}</Alert>}
        <div>
          <Button type="submit" disabled={!name.trim() || scopes.length === 0 || create.isPending}>
            {t('integrations.keys.create')}
          </Button>
        </div>
      </form>
    </div>
  );
}

function WebhooksCard() {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const endpointsKey = ['webhook-endpoints', currentPropertyId ?? ''];
  const deliveriesKey = ['webhook-deliveries', currentPropertyId ?? ''];
  const endpoints = useQuery({ queryKey: endpointsKey, queryFn: listEndpoints });
  const deliveries = useQuery({ queryKey: deliveriesKey, queryFn: listDeliveries });
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: endpointsKey });
    void queryClient.invalidateQueries({ queryKey: deliveriesKey });
  };
  const [url, setUrl] = useState('');
  const [description, setDescription] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      api.call('createWebhookEndpoint', {
        body: {
          url: url.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          events: PARTNER_EVENT_TYPES.filter((e) => events.includes(e)),
        },
      }),
    onSuccess: (made) => {
      setSecret(made.secret);
      setUrl('');
      setDescription('');
      setEvents([]);
      refresh();
    },
  });
  const change = useMutation({
    mutationFn: (e: Endpoint) =>
      api.call('updateWebhookEndpoint', {
        params: { endpointId: e.id },
        body: { active: !e.active },
      }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: (e: Endpoint) => api.call('testWebhookEndpoint', { params: { endpointId: e.id } }),
    onSuccess: refresh,
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.call('retryWebhookDelivery', { params: { deliveryId: id } }),
    onSuccess: refresh,
  });
  const failure = endpoints.error ?? change.error ?? test.error ?? retry.error;
  const eventName = (e: string) => t(`integrations.event.${k(e)}`);
  return (
    <div className={`${card} mt-4`}>
      <h2 className="font-semibold">{t('integrations.hooks.title')}</h2>
      <p className="mt-1 text-sm text-text-muted">{t('integrations.hooks.intro')}</p>
      {secret && (
        <ShownOnce
          label={t('integrations.hooks.made')}
          value={secret}
          onDone={() => setSecret(null)}
        />
      )}
      {failure && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(failure)}
        </Alert>
      )}
      {endpoints.data?.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('integrations.hooks.none')}</p>
      )}
      <ul aria-label={t('integrations.hooks.list')} className="mt-3 flex flex-col gap-2">
        {endpoints.data?.data.map((e) => (
          <li key={e.id} className="rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="break-all font-medium">{e.url}</span>
              <span className="flex gap-2">
                {!e.active && (
                  <span className="text-text-muted">{t('integrations.hooks.paused')}</span>
                )}
                <Button size="sm" variant="secondary" onClick={() => test.mutate(e)}>
                  {t('integrations.hooks.test')}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => change.mutate(e)}>
                  {e.active ? t('integrations.hooks.pause') : t('integrations.hooks.resume')}
                </Button>
              </span>
            </div>
            {e.description && <p>{e.description}</p>}
            <p className="text-text-muted">
              {t('integrations.hooks.eventsLine', { events: e.events.map(eventName).join(', ') })}
            </p>
            <p className="text-text-muted">
              {t('integrations.hooks.stats', {
                delivered: e.delivered,
                failed: e.failed,
                pending: e.pending,
              })}
            </p>
          </li>
        ))}
      </ul>
      <form
        aria-label={t('integrations.hooks.create')}
        className="mt-4 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div>
          <Label htmlFor="hook-url">{t('integrations.hooks.url')}</Label>
          <Input
            id="hook-url"
            type="url"
            value={url}
            placeholder="https://"
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="hook-description">{t('integrations.hooks.description')}</Label>
          <Input
            id="hook-description"
            value={description}
            maxLength={200}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <fieldset>
          <legend className="text-sm font-medium">{t('integrations.hooks.events')}</legend>
          {PARTNER_EVENT_TYPES.map((ev) => (
            <label key={ev} className="mt-1 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={events.includes(ev)}
                onChange={(e) =>
                  setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))
                }
              />
              {eventName(ev)}
            </label>
          ))}
        </fieldset>
        {create.error && <Alert tone="critical">{errorMessage(create.error)}</Alert>}
        <div>
          <Button type="submit" disabled={!url.trim() || events.length === 0 || create.isPending}>
            {t('integrations.hooks.create')}
          </Button>
        </div>
      </form>
      <DeliveryList data={deliveries.data} onRetry={(id) => retry.mutate(id)} />
    </div>
  );
}

function DeliveryList({
  data,
  onRetry,
}: {
  data: Deliveries | undefined;
  onRetry: (id: string) => void;
}) {
  const { t } = useTranslation();
  const f = useFormats();
  return (
    <>
      <h3 className="mt-5 font-semibold">{t('integrations.deliveries.title')}</h3>
      {data?.data.length === 0 && (
        <p className="mt-2 text-sm text-text-muted">{t('integrations.deliveries.none')}</p>
      )}
      <ul aria-label={t('integrations.deliveries.list')} className="mt-2 flex flex-col gap-1">
        {data?.data.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="break-all">
              {t('integrations.deliveries.line', {
                event: t(`integrations.event.${k(d.eventType)}`),
                url: d.url,
                when: f.when(d.createdAt),
              })}
            </span>
            <span className="flex items-center gap-2">
              <span>
                {t(`integrations.deliveries.status.${d.status}`)} ·{' '}
                {t('integrations.deliveries.tries', { count: d.attempts })}
                {d.lastError ? ` · ${d.lastError}` : ''}
              </span>
              {d.status === 'FAILED' && (
                <Button size="sm" variant="secondary" onClick={() => onRetry(d.id)}>
                  {t('integrations.deliveries.retry')}
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
