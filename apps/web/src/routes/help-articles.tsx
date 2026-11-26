import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import helpdeskStrings from '../i18n/en/helpdesk.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';

registerStrings(helpdeskStrings);

// Help centre (Versions V2 "enhanced onboarding, support tooling"; T-173): articles the
// platform team writes, searched from Help; the page the user came from brings its own first.

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul' | 'ol'; items: string[] };

const BULLET = /^-\s+/;
const NUMBER = /^\d+\.\s+/;

/** Plain text → paragraphs and lists: blank lines split blocks; "- " and "1. " make lists. */
export function blocksOf(text: string): Block[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((chunk) =>
      chunk
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    )
    .filter((lines) => lines.length > 0)
    .map((lines): Block => {
      if (lines.every((l) => BULLET.test(l))) {
        return { kind: 'ul', items: lines.map((l) => l.replace(BULLET, '')) };
      }
      if (lines.every((l) => NUMBER.test(l))) {
        return { kind: 'ol', items: lines.map((l) => l.replace(NUMBER, '')) };
      }
      return { kind: 'p', lines };
    });
}

/** An article's text, rendered as text only: nothing in it can become markup. */
export function ArticleBody({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-3 text-sm">
      {blocksOf(text).map((b, i) =>
        b.kind === 'p' ? (
          <p key={i} className="whitespace-pre-line">
            {b.lines.join('\n')}
          </p>
        ) : b.kind === 'ul' ? (
          <ul key={i} className="list-disc pl-5">
            {b.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ) : (
          <ol key={i} className="list-decimal pl-5">
            {b.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ol>
        ),
      )}
    </div>
  );
}

function Article({ slug, onBack }: { slug: string; onBack: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['help', 'article', slug],
    queryFn: () => api.call('getHelpArticle', { params: { slug } }),
  });
  return (
    <article aria-label={q.data?.title ?? slug} className="flex flex-col gap-3">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          {t('helpdesk.articles.back')}
        </Button>
      </div>
      {q.error && <Alert tone="critical">{errorMessage(q.error)}</Alert>}
      {q.data && (
        <>
          <h3 className="text-lg font-semibold">{q.data.title}</h3>
          <ArticleBody text={q.data.body} />
        </>
      )}
    </article>
  );
}

/** Help articles on the Help page: the page's own first, a search, and the article read. */
export function HelpArticles({ page }: { page: string | null }) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const q = search.trim();
  const list = useQuery({
    queryKey: ['help', 'list', q, page],
    queryFn: () =>
      api.call('listHelpArticles', {
        query: { ...(q ? { q } : {}), ...(page ? { page } : {}) },
      }),
  });
  return (
    <section aria-label={t('helpdesk.articles.title')} className="mb-6">
      <h2 className="font-semibold">
        {page && !q ? t('helpdesk.articles.forPage') : t('helpdesk.articles.title')}
      </h2>
      {open ? (
        <Article key={open} slug={open} onBack={() => setOpen(null)} />
      ) : (
        <>
          <div className="mt-2 flex max-w-md flex-col gap-1">
            <Label htmlFor="help-search">{t('helpdesk.articles.search')}</Label>
            <Input
              id="help-search"
              type="search"
              maxLength={100}
              placeholder={t('helpdesk.articles.searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {list.error && (
            <Alert tone="critical" className="mt-2">
              {errorMessage(list.error)}
            </Alert>
          )}
          {list.data && list.data.data.length === 0 && (
            <p className="mt-2 text-sm text-text-muted">{t('helpdesk.articles.none')}</p>
          )}
          <ul className="mt-2 flex flex-col gap-2">
            {list.data?.data.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="w-full rounded-md border border-border bg-surface p-3 text-left text-sm"
                  onClick={() => setOpen(a.slug)}
                >
                  <span className="block font-semibold">{a.title}</span>
                  <span className="block text-text-muted">{a.excerpt}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
