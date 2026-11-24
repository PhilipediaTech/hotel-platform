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
import reviewStrings from '../i18n/en/reviews.json';
import { registerStrings } from '../i18n/index.ts';
import { useFormats } from './reservations.tsx';

registerStrings(reviewStrings);

// Reviews (PRD M14-15; T-155; on S29's side of the app): whether guests are asked for a review
// after check-out, what they said, and the reply. The AI's draft is only a starting point:
// nothing reaches the guest until the GM presses Send.

const card = 'rounded-md border border-border bg-surface p-4';
const FILTERS = ['WAITING', 'REPLIED', 'REQUESTED', 'ALL'] as const;
type Filter = (typeof FILTERS)[number];

type List = Awaited<ReturnType<typeof listOf>>;
type Review = List['data'][number];
const listOf = (filter: Filter) =>
  api.call('listReviews', { query: filter === 'ALL' ? {} : { status: filter } });

export function ReviewsPage() {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const [filter, setFilter] = useState<Filter>('WAITING');
  const key = ['reviews', currentPropertyId ?? '', filter];
  const list = useQuery({ queryKey: key, queryFn: () => listOf(filter) });
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['reviews'] });
  const s = list.data?.summary;
  return (
    <section className="max-w-3xl">
      <h1 className="text-xl font-semibold">{t('reviews.title')}</h1>
      <p className="mt-1 text-sm text-text-muted">{t('reviews.intro')}</p>
      <ReviewSettingsCard />
      {s && (
        <p className="mt-4 text-sm" aria-label={t('reviews.summaryLabel')}>
          {s.averageRating !== null
            ? t('reviews.summary', {
                average: s.averageRating,
                answered: s.answered,
                requested: s.requested,
              })
            : t('reviews.summaryNone', { requested: s.requested })}{' '}
          · {t('reviews.waitingCount', { count: s.waiting })}
        </p>
      )}
      <div role="tablist" aria-label={t('reviews.filter')} className="mt-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Button
            key={f}
            role="tab"
            aria-selected={filter === f}
            variant={filter === f ? 'primary' : 'secondary'}
            onClick={() => setFilter(f)}
          >
            {t(`reviews.filters.${f}`)}
          </Button>
        ))}
      </div>
      {list.error && (
        <Alert tone="critical" className="mt-3">
          {errorMessage(list.error)}
        </Alert>
      )}
      {list.data?.data.length === 0 && (
        <p className="mt-3 text-sm text-text-muted">{t('reviews.none')}</p>
      )}
      <ul aria-label={t('reviews.list')} className="mt-3 flex flex-col gap-3">
        {list.data?.data.map((r) => (
          <ReviewCard key={r.id} review={r} onDone={refresh} />
        ))}
      </ul>
    </section>
  );
}

function ReviewSettingsCard() {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const key = ['review-settings', currentPropertyId ?? ''];
  const settings = useQuery({ queryKey: key, queryFn: () => api.call('getReviewSettings', {}) });
  const [draft, setDraft] = useState<{
    enabled: boolean;
    delayHours: string;
    publicReviewUrl: string;
  } | null>(null);
  const queryClient = useQueryClient();
  const current = settings.data;
  const form =
    draft ??
    (current
      ? {
          enabled: current.enabled,
          delayHours: String(current.delayHours),
          publicReviewUrl: current.publicReviewUrl ?? '',
        }
      : null);
  const save = useMutation({
    mutationFn: () =>
      api.call('updateReviewSettings', {
        body: {
          enabled: form?.enabled ?? false,
          delayHours: Number(form?.delayHours ?? 3),
          publicReviewUrl: form?.publicReviewUrl.trim() || null,
        },
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(key, saved);
      setDraft(null);
    },
  });
  if (!form) return null;
  const set = (patch: Partial<typeof form>) => setDraft({ ...form, ...patch });
  return (
    <form
      aria-label={t('reviews.settings.title')}
      className={`${card} mt-4 flex flex-col gap-3`}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 className="font-semibold">{t('reviews.settings.title')}</h2>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-5"
          checked={form.enabled}
          onChange={(e) => set({ enabled: e.target.checked })}
        />
        {t('reviews.settings.enabled')}
      </label>
      <div className="flex flex-col gap-1">
        <Label htmlFor="review-delay">{t('reviews.settings.delay')}</Label>
        <Input
          id="review-delay"
          type="number"
          min={1}
          max={72}
          className="w-28"
          value={form.delayHours}
          onChange={(e) => set({ delayHours: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="review-public">{t('reviews.settings.publicUrl')}</Label>
        <Input
          id="review-public"
          type="url"
          placeholder="https://"
          value={form.publicReviewUrl}
          onChange={(e) => set({ publicReviewUrl: e.target.value })}
        />
        <small className="text-text-muted">{t('reviews.settings.publicUrlHint')}</small>
      </div>
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
      <div>
        <Button type="submit" disabled={save.isPending || draft === null}>
          {t('reviews.settings.save')}
        </Button>
      </div>
    </form>
  );
}

function Stars({ rating }: { rating: number }) {
  const { t } = useTranslation();
  return (
    <span aria-label={t('reviews.stars', { count: rating })} className="text-warning">
      {'★'.repeat(rating)}
      <span className="text-text-muted">{'★'.repeat(5 - rating)}</span>
    </span>
  );
}

function ReviewCard({ review: r, onDone }: { review: Review; onDone: () => void }) {
  const { t } = useTranslation();
  const f = useFormats();
  const [text, setText] = useState<string | null>(null);
  const reply = text ?? r.draft ?? '';
  const redraft = useMutation({
    mutationFn: () => api.call('draftReviewReply', { params: { reviewId: r.id } }),
    onSuccess: (updated) => {
      setText(updated.draft ?? '');
    },
  });
  const send = useMutation({
    mutationFn: () =>
      api.call('replyToReview', { params: { reviewId: r.id }, body: { reply: reply.trim() } }),
    onSuccess: onDone,
  });
  return (
    <li className={card}>
      <p className="flex flex-wrap items-center gap-2">
        {r.rating !== null && <Stars rating={r.rating} />}
        <span className="font-medium">{r.guest.name}</span>
        <span className="text-sm text-text-muted">
          {r.confirmationNo} · {f.date(r.arrival)} – {f.date(r.departure)}
        </span>
      </p>
      {r.status === 'REQUESTED' && (
        <p className="mt-1 text-sm text-text-muted">
          {t('reviews.asked', {
            when: f.when(r.requestedAt),
            channel: t(`reviews.channel.${r.channel}`),
          })}
        </p>
      )}
      {r.status !== 'REQUESTED' && (
        <p className="mt-2 whitespace-pre-line">{r.comment ?? t('reviews.noComment')}</p>
      )}
      {r.status === 'REPLIED' && (
        <div className="mt-3 border-l-2 border-border pl-3 text-sm">
          <p className="whitespace-pre-line">{r.reply}</p>
          <p className="mt-1 text-text-muted">
            {t('reviews.repliedBy', {
              name: r.repliedBy?.name ?? '',
              when: r.repliedAt ? f.when(r.repliedAt) : '',
            })}
          </p>
        </div>
      )}
      {r.status === 'WAITING' && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send.mutate();
          }}
        >
          <Label htmlFor={`reply-${r.id}`}>
            {r.draft ? t('reviews.replyDrafted') : t('reviews.reply')}
          </Label>
          <textarea
            id={`reply-${r.id}`}
            className="min-h-28 rounded-md border border-border bg-surface p-2 text-sm"
            maxLength={2000}
            value={reply}
            onChange={(e) => setText(e.target.value)}
          />
          {(redraft.error ?? send.error) && (
            <Alert tone="critical">{errorMessage(redraft.error ?? send.error)}</Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={send.isPending || reply.trim() === ''}>
              {t('reviews.send')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={redraft.isPending}
              onClick={() => redraft.mutate()}
            >
              {t('reviews.redraft')}
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}
