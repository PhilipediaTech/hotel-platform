# hotel-platform

Hotel management platform (PMS) for independent hotels. npm-workspaces monorepo:

| Path              | Package         | What                                                       |
| ----------------- | --------------- | ---------------------------------------------------------- |
| `apps/api`        | `@hotel/api`    | Express 5 API + pg-boss worker                             |
| `apps/web`        | `@hotel/web`    | Staff and owner PWA (React + Vite)                         |
| `apps/site`       | `@hotel/site`   | Booking engine and marketing site (Astro)                  |
| `packages/shared` | `@hotel/shared` | Shared Zod schemas, state machines, money and date helpers |

## Getting started

Requires Node 24 (see `.nvmrc`).

```bash
npm install
npm run check
```

Project status: `docs/PROGRESS.md`. Pinned versions: `docs/VERSIONS.md`. Decisions: `docs/adr/`.
