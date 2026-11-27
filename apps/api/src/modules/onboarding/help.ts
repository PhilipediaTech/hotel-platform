import type { HelpArticleBody, HelpArticleItem, HelpArticleSummary } from '@hotel/shared';
import type { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.ts';
import type { AuthContext } from '../../core/auth.ts';
import type { Clock } from '../../core/clock.ts';
import { pgErrorInfo, type Db } from '../../core/db.ts';
import { AppError } from '../../core/errors.ts';

// Help centre (Versions V2 "enhanced onboarding, support tooling"; T-173; Philip's choices
// 2026-11-26). Articles are the platform's, the same for every hotel: read with the plain
// client, written only by platform staff. Unpublishing hides an article; nothing is deleted.

export interface HelpDeps {
  db: Db;
  clock: Clock;
}

type Summary = z.input<typeof HelpArticleSummary>;
type Item = z.input<typeof HelpArticleItem>;
type Body = z.output<typeof HelpArticleBody>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const EXCERPT = 160;
const INCLUDE = { updatedBy: { select: { id: true, name: true } } } as const;
type Row = Prisma.HelpArticleGetPayload<{ include: typeof INCLUDE }>;

function excerpt(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT ? `${flat.slice(0, EXCERPT - 1)}…` : flat;
}

const summaryOf = (a: Row): Summary => ({
  id: a.id,
  slug: a.slug,
  title: a.title,
  excerpt: excerpt(a.body),
  pages: a.pages,
});

const itemOf = (a: Row): Item => ({
  ...summaryOf(a),
  body: a.body,
  published: a.published,
  updatedAt: iso(a.updatedAt),
  updatedBy: a.updatedBy,
});

/** "/front-desk?tab=alerts" → "/front-desk". */
const pathOf = (page: string) => page.split(/[?#]/)[0] ?? page;

export async function listArticles(deps: HelpDeps, query: { q?: string; page?: string }) {
  const words = (query.q ?? '').split(/\s+/).filter(Boolean).slice(0, 8);
  const rows = await deps.db.helpArticle.findMany({
    where: {
      published: true,
      AND: words.map((w) => ({
        OR: [
          { title: { contains: w, mode: 'insensitive' as const } },
          { body: { contains: w, mode: 'insensitive' as const } },
        ],
      })),
    },
    include: INCLUDE,
    orderBy: { title: 'asc' },
    take: 100,
  });
  // The page's own articles first; with a page and no search, only those.
  const page = query.page ? pathOf(query.page) : null;
  const forPage = (a: Row) => page !== null && a.pages.includes(page);
  const chosen =
    page !== null && words.length === 0 && rows.some(forPage) ? rows.filter(forPage) : rows;
  const sorted = [...chosen].sort((a, b) => Number(forPage(b)) - Number(forPage(a)));
  return { data: sorted.map(summaryOf) };
}

export async function getArticle(deps: HelpDeps, slug: string) {
  const row = await deps.db.helpArticle.findUnique({ where: { slug }, include: INCLUDE });
  if (!row?.published) throw new AppError('NOT_FOUND', 'Help article not found');
  return itemOf(row);
}

export async function listAllArticles(deps: HelpDeps) {
  const rows = await deps.db.helpArticle.findMany({
    include: INCLUDE,
    orderBy: [{ published: 'asc' }, { title: 'asc' }],
  });
  return { data: rows.map(itemOf) };
}

function slugTaken(err: unknown): boolean {
  const info = pgErrorInfo(err);
  return info?.constraint === 'help_articles_slug_key';
}

const slugError = () =>
  new AppError('VALIDATION_ERROR', 'Another article has this slug', {
    issues: [{ path: 'body.slug', code: 'custom', message: 'Another article has this slug' }],
  });

const dataOf = (auth: AuthContext, body: Body, now: Date) => ({
  slug: body.slug,
  title: body.title,
  body: body.body,
  pages: [...new Set(body.pages.map(pathOf))],
  published: body.published,
  updatedById: auth.user.id,
  updatedAt: now,
});

export async function createArticle(deps: HelpDeps, auth: AuthContext, body: Body) {
  try {
    const row = await deps.db.helpArticle.create({
      data: dataOf(auth, body, deps.clock()),
      include: INCLUDE,
    });
    return itemOf(row);
  } catch (err) {
    if (slugTaken(err)) throw slugError();
    throw err;
  }
}

export async function updateArticle(
  deps: HelpDeps,
  auth: AuthContext,
  articleId: string,
  body: Body,
) {
  const found = await deps.db.helpArticle.findUnique({ where: { id: articleId } });
  if (!found) throw new AppError('NOT_FOUND', 'Help article not found');
  try {
    const row = await deps.db.helpArticle.update({
      where: { id: found.id },
      data: dataOf(auth, body, deps.clock()),
      include: INCLUDE,
    });
    return itemOf(row);
  } catch (err) {
    if (slugTaken(err)) throw slugError();
    throw err;
  }
}
