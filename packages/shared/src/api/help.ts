import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Instant, Uuid } from './primitives.ts';

// Help centre (Versions V2 "enhanced onboarding, support tooling"; Strategy "published help
// centre"; T-173, Philip 2026-11-26). The platform team writes articles for every hotel in
// S31; signed-in staff search the published ones from Help, where the page they came from
// brings up its own articles. Plain text: paragraphs, and lines starting "- " or "1. ".

const Slug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lowercase letters, digits and dashes, e.g. take-a-payment')
  .max(80);
const Page = z
  .string()
  .trim()
  // A query or anchor is allowed; the page is kept without it.
  .regex(/^\/[a-z0-9/-]*([?#].*)?$/, 'An app page, e.g. /front-desk')
  .max(100);

export const HelpArticleSummary = z
  .object({
    id: Uuid,
    slug: z.string(),
    title: z.string(),
    /** The first words of the body. */
    excerpt: z.string(),
    pages: z.array(z.string()),
  })
  .meta({ id: 'HelpArticleSummary' });

export const HelpArticleItem = HelpArticleSummary.extend({
  body: z.string(),
  published: z.boolean(),
  updatedAt: Instant,
  updatedBy: z.object({ id: Uuid, name: z.string() }).nullable(),
}).meta({ id: 'HelpArticle' });

export const HelpArticleBody = z.object({
  slug: Slug,
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(20000),
  pages: z.array(Page).max(10).default([]),
  published: z.boolean().default(false),
});

export const listHelpArticles = defineRoute({
  operationId: 'listHelpArticles',
  method: 'get',
  path: '/help/articles',
  summary: 'Published help articles: those for a page, or matching a search',
  tags: ['Support'],
  query: z.object({
    /** Words in the title or body. */
    q: z.string().trim().max(100).optional(),
    /** An app page: its own articles first. */
    page: z.string().trim().max(200).optional(),
  }),
  response: z.object({ data: z.array(HelpArticleSummary) }),
});

export const getHelpArticle = defineRoute({
  operationId: 'getHelpArticle',
  method: 'get',
  path: '/help/articles/{slug}',
  summary: 'A published help article',
  tags: ['Support'],
  params: z.object({ slug: z.string().max(80) }),
  response: HelpArticleItem,
});

const PLATFORM = { tags: ['Platform'], platform: true as const };

export const listPlatformHelpArticles = defineRoute({
  ...PLATFORM,
  operationId: 'listPlatformHelpArticles',
  method: 'get',
  path: '/platform/help/articles',
  summary: 'Every help article, drafts included',
  response: z.object({ data: z.array(HelpArticleItem) }),
});

export const createHelpArticle = defineRoute({
  ...PLATFORM,
  operationId: 'createHelpArticle',
  method: 'post',
  path: '/platform/help/articles',
  summary: 'Write a help article (a draft unless published)',
  status: 201,
  body: HelpArticleBody,
  response: HelpArticleItem,
});

export const updateHelpArticle = defineRoute({
  ...PLATFORM,
  operationId: 'updateHelpArticle',
  method: 'put',
  path: '/platform/help/articles/{articleId}',
  summary: 'Change, publish or unpublish a help article',
  params: z.object({ articleId: Uuid }),
  body: HelpArticleBody,
  response: HelpArticleItem,
});

export const HELP_ROUTES = {
  listHelpArticles,
  getHelpArticle,
  listPlatformHelpArticles,
  createHelpArticle,
  updateHelpArticle,
} as const;
