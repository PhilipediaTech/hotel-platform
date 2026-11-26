import type { HelpArticleItem } from '@hotel/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { Alert } from '../components/ui/alert.tsx';
import { Button } from '../components/ui/button.tsx';
import { Input } from '../components/ui/input.tsx';
import { Label } from '../components/ui/label.tsx';
import helpdeskStrings from '../i18n/en/helpdesk.json';
import { registerStrings } from '../i18n/index.ts';
import { api } from '../lib/api.ts';
import { errorMessage } from '../lib/form.ts';
import { ArticleBody } from './help-articles.tsx';

registerStrings(helpdeskStrings);

// S31 help centre (T-173): the platform team writes, publishes and unpublishes the articles
// every hotel reads from Help.

type Article = z.output<typeof HelpArticleItem>;
const KEY = ['platform', 'help'];

function Editor({ article, onDone }: { article: Article | null; onDone: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState(article?.slug ?? '');
  const [title, setTitle] = useState(article?.title ?? '');
  const [pages, setPages] = useState(article?.pages.join(', ') ?? '');
  const [body, setBody] = useState(article?.body ?? '');
  const [published, setPublished] = useState(article?.published ?? false);
  const save = useMutation({
    mutationFn: () => {
      const payload = {
        slug,
        title,
        body,
        published,
        pages: pages
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
      };
      return article
        ? api.call('updateHelpArticle', { params: { articleId: article.id }, body: payload })
        : api.call('createHelpArticle', { body: payload });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      onDone();
    },
  });
  return (
    <form
      aria-label={article ? article.title : t('helpdesk.articles.newArticle')}
      className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="help-title">{t('helpdesk.articles.articleTitle')}</Label>
          <Input
            id="help-title"
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="help-slug">{t('helpdesk.articles.slug')}</Label>
          <Input
            id="help-slug"
            maxLength={80}
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="help-pages">{t('helpdesk.articles.pages')}</Label>
        <Input id="help-pages" value={pages} onChange={(e) => setPages(e.target.value)} />
        <p className="text-xs text-text-muted">{t('helpdesk.articles.pagesHint')}</p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="help-body">{t('helpdesk.articles.body')}</Label>
        <textarea
          id="help-body"
          maxLength={20000}
          className="min-h-48 rounded-md border border-border bg-surface p-2 font-mono text-sm"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <p className="text-xs text-text-muted">{t('helpdesk.articles.bodyHint')}</p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={published}
          onChange={(e) => setPublished(e.target.checked)}
        />
        {t('helpdesk.articles.published')}
      </label>
      {body.trim() && (
        <section
          aria-label={t('helpdesk.articles.preview')}
          className="rounded-md border border-border p-3"
        >
          <h4 className="mb-2 text-xs font-semibold text-text-muted">
            {t('helpdesk.articles.preview')}
          </h4>
          <ArticleBody text={body} />
        </section>
      )}
      {save.error && <Alert tone="critical">{errorMessage(save.error)}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending || !slug || !title || !body.trim()}>
          {t('helpdesk.articles.save')}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          {t('helpdesk.articles.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** Every article, drafts first; write a new one or edit any. */
export function HelpCentreAdmin() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.call('listPlatformHelpArticles') });
  const [editing, setEditing] = useState<Article | 'new' | null>(null);
  return (
    <section aria-label={t('helpdesk.articles.manage')} className="mt-8">
      <h2 className="text-lg font-semibold">{t('helpdesk.articles.manage')}</h2>
      {q.error && (
        <Alert tone="critical" className="mt-2">
          {errorMessage(q.error)}
        </Alert>
      )}
      {editing ? (
        <div className="mt-2">
          <Editor
            key={editing === 'new' ? 'new' : editing.id}
            article={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        </div>
      ) : (
        <>
          <div className="mt-2">
            <Button onClick={() => setEditing('new')}>{t('helpdesk.articles.newArticle')}</Button>
          </div>
          <ul className="mt-2 flex flex-col gap-2">
            {q.data?.data.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface p-3 text-sm"
              >
                <span>
                  <span className="block font-semibold">{a.title}</span>
                  <span className="block text-text-muted">
                    {a.published ? t('helpdesk.articles.published') : t('helpdesk.articles.draft')}
                    {a.pages.length > 0 && ` · ${a.pages.join(', ')}`}
                  </span>
                </span>
                <Button size="sm" variant="secondary" onClick={() => setEditing(a)}>
                  {t('helpdesk.articles.edit')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
