import type { SearchHit } from '@hotel/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import type { z } from 'zod';
import { useSession } from '../app/session.ts';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Label } from '../components/ui/label.tsx';
import strings from '../i18n/en/search.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';

registerStrings(strings);

// Search (tab 5 "Global search", spec issue 31; Versions V3 "AI search"; T-178). Plain matches
// come straight away and use no AI; "Ask AI" turns a sentence into filters on the same lists.
// The records shown always come from those lists, never from the model.

type Hit = z.output<typeof SearchHit>;
const KINDS = ['GUEST', 'RESERVATION', 'ROOM', 'TASK'] as const;

const hrefOf = (h: Hit) =>
  h.kind === 'GUEST'
    ? `/guests/${h.id}`
    : h.kind === 'RESERVATION'
      ? `/reservations/${h.id}`
      : h.kind === 'TASK'
        ? `/tasks/${h.id}`
        : '/housekeeping';

function Hits({ hits }: { hits: Hit[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      {KINDS.map((kind) => {
        const of = hits.filter((h) => h.kind === kind);
        if (!of.length) return null;
        return (
          <section key={kind} aria-label={t(`search.kind.${kind}`)}>
            <h3 className="text-sm font-semibold text-text-muted">{t(`search.kind.${kind}`)}</h3>
            <ul className="mt-1 flex flex-col gap-1">
              {of.map((h) => (
                <li key={h.id}>
                  <Link className="text-brand underline" to={hrefOf(h)}>
                    {h.label}
                  </Link>
                  {h.detail && <span className="text-sm text-text-muted"> · {h.detail}</span>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q')?.trim() ?? '';
  // A new search starts afresh: its own box text and no earlier AI answer.
  return <Results key={q} q={q} onSearch={(next) => setParams({ q: next })} />;
}

function Results({ q, onSearch }: { q: string; onSearch: (q: string) => void }) {
  const { t } = useTranslation();
  const { currentPropertyId } = useSession();
  const [text, setText] = useState(q);
  const plain = q.length >= 2 && q.length <= 100;
  const found = useQuery({
    queryKey: ['search', currentPropertyId, q],
    queryFn: () => api.call('search', { query: { q } }),
    enabled: plain && !!currentPropertyId,
  });
  const ask = useMutation({
    mutationFn: (question: string) => api.call('askSearch', { body: { question } }),
  });

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-xl font-semibold">{t('search.title')}</h1>
      <form
        role="search"
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) onSearch(text.trim());
        }}
      >
        <Label htmlFor="search-q">{t('search.label')}</Label>
        <div className="flex flex-wrap gap-2">
          <input
            id="search-q"
            type="search"
            maxLength={300}
            className="h-10 min-w-0 flex-1 rounded-md border border-border bg-surface px-3 text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button type="submit">{t('search.submit')}</Button>
        </div>
      </form>

      {q && (
        <>
          {plain && found.error && <Alert tone="critical">{errorMessage(found.error)}</Alert>}
          {plain && found.data && found.data.hits.length === 0 && (
            <p className="text-sm">{t('search.none')}</p>
          )}
          {found.data && plain && <Hits hits={found.data.hits} />}
          {!plain && <p className="text-sm text-text-muted">{t('search.tooLong')}</p>}

          <section
            aria-labelledby="search-ask"
            className="rounded-md border border-border bg-surface p-4"
          >
            <h2 id="search-ask" className="font-semibold">
              {t('search.ask.title')}
            </h2>
            <p className="text-sm text-text-muted">{t('search.ask.hint')}</p>
            <div className="mt-2">
              <Button
                variant="secondary"
                disabled={ask.isPending || q.length < 3}
                onClick={() => ask.mutate(q)}
              >
                {ask.isPending ? t('search.ask.thinking') : t('search.ask.submit')}
              </Button>
            </div>
            {ask.error && (
              <Alert tone="critical" className="mt-3">
                {errorMessage(ask.error)}
              </Alert>
            )}
            {ask.data && (
              <div className="mt-3 flex flex-col gap-3">
                <p className="text-sm">
                  <span className="font-medium">{t('search.ask.byAi')}</span> {ask.data.answer}
                </p>
                {ask.data.hits.length ? (
                  <Hits hits={ask.data.hits} />
                ) : (
                  <p className="text-sm">{t('search.ask.none')}</p>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
