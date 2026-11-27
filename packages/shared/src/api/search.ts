import { z } from 'zod';
import { defineRoute } from './contract.ts';
import { Uuid } from './primitives.ts';

// Search from the top bar (tab 5 "Global search", spec issue 31; Versions V3 "AI search";
// T-178; Philip chose plain matches plus "Ask AI", over guests, bookings, rooms and tasks,
// 2026-11-27). Plain search uses no AI. "Ask AI" turns a sentence into filters on the same
// read-only lists: the records it shows come from those lists, never from the model, and only
// what the caller may open there.

export const SEARCH_KINDS = ['GUEST', 'RESERVATION', 'ROOM', 'TASK'] as const;
/** Most matches of each kind in plain search. */
export const SEARCH_PER_KIND = 5;
/** Most records one AI search shows. */
export const ASK_SEARCH_LIMIT = 30;

export const SearchHit = z
  .object({
    kind: z.enum(SEARCH_KINDS),
    id: Uuid,
    label: z.string(),
    detail: z.string().nullable(),
  })
  .meta({ id: 'SearchHit' });

const COMMON = { tags: ['Search'], propertyScoped: true as const };

export const search = defineRoute({
  ...COMMON,
  operationId: 'search',
  method: 'get',
  path: '/search',
  summary: 'Find guests, bookings, rooms and tasks by name, number or phone',
  description:
    'Each kind only for callers who may list it: guests with guest.manage, bookings with frontdesk.read, rooms for everyone, tasks as the task queue shows them. No AI.',
  query: z.object({ q: z.string().trim().min(2).max(100) }),
  response: z.object({ hits: z.array(SearchHit) }),
});

export const askSearch = defineRoute({
  ...COMMON,
  operationId: 'askSearch',
  method: 'post',
  path: '/search/ask',
  summary: 'Search in your own words, with AI (T-178)',
  description:
    'The model chooses filters on the same lists as plain search, with the same permissions; the records come from those lists. Reads only. 503 AI_UNAVAILABLE when the AI is off or unreachable; 403 ALLOWANCE_USED_UP when the month’s AI allowance is gone.',
  body: z.object({ question: z.string().trim().min(3).max(300) }),
  response: z.object({ answer: z.string(), hits: z.array(SearchHit) }),
  errors: ['AI_UNAVAILABLE', 'ALLOWANCE_USED_UP'],
});

export const SEARCH_ROUTES = { search, askSearch } as const;
