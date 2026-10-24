# Pinned versions

Pinned on 2026-10-22 from the npm registry and nodejs.org. Exact versions only (`.npmrc` has `save-exact=true`). Do not move a major version without Philip's approval.

**Installed** = in `package.json` now. **Planned** = pinned here; installed by the ticket shown.

## Runtime and database

| Tool               | Version                        | Status              | Notes                                                                                           |
| ------------------ | ------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------- |
| Node.js            | 24.22.1 (Active LTS "Krypton") | `.nvmrc`, `engines` | Node 26 is "Current", not LTS. Local machine still has 22.15.0 — upgrade needed                 |
| npm                | 11.x (bundled with Node 24)    | —                   |                                                                                                 |
| PostgreSQL (local) | 18                             | Installed natively  | Spec minimum is 16. CI and Render must use the same major as production (decide at T-004/T-005) |

## Tooling (installed in T-001)

| Package                | Version | Notes                                                                                                                                           |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| typescript             | 6.0.3   | **Deviation:** 7.0.2 is the latest stable, but typescript-eslint 8.72.0 supports `typescript <6.1.0`. Revisit when typescript-eslint supports 7 |
| @types/node            | 24.19.2 | Matches Node 24                                                                                                                                 |
| eslint                 | 10.13.0 | Flat config                                                                                                                                     |
| @eslint/js             | 10.0.1  |                                                                                                                                                 |
| typescript-eslint      | 8.72.0  | Type-checked rules                                                                                                                              |
| eslint-config-prettier | 10.1.8  |                                                                                                                                                 |
| globals                | 17.13.0 |                                                                                                                                                 |
| prettier               | 3.9.10  |                                                                                                                                                 |
| husky                  | 9.1.7   | Git hooks                                                                                                                                       |
| lint-staged            | 17.6.0  | Requires Node ≥ 22.22.1                                                                                                                         |
| vitest                 | 5.0.5   |                                                                                                                                                 |

## API (installed in T-002, `apps/api`)

| Package                                         | Version                | Notes                                        |
| ----------------------------------------------- | ---------------------- | -------------------------------------------- |
| express                                         | 5.3.0                  |                                              |
| helmet                                          | 8.3.0                  |                                              |
| pino / pino-http                                | 10.4.0 / 11.0.0        |                                              |
| supertest                                       | 7.3.1                  | dev                                          |
| cors                                            | 2.8.6                  | Added; not in the spec's stack list          |
| zod                                             | 4.6.7                  | Env config now; API schemas from T-007       |
| pino-pretty                                     | 13.2.0                 | dev; pretty logs when `NODE_ENV=development` |
| @types/express / @types/cors / @types/supertest | 5.0.6 / 2.8.19 / 7.2.1 | dev                                          |

`tsx` is no longer planned: Node 24 runs the TypeScript source directly (see PROGRESS decisions).

## Database (installed in T-003)

| Package            | Version         | Notes                                                                                     |
| ------------------ | --------------- | ----------------------------------------------------------------------------------------- |
| prisma (root, dev) | 7.10.1          | npm `latest` tag points at `8.0.0-rc.25` (release candidate); 7.10.1 is the latest stable |
| @prisma/client     | 7.10.1          | `apps/api`                                                                                |
| @prisma/adapter-pg | 7.10.1          | Prisma 7 driver adapter                                                                   |
| pg / @types/pg     | 8.23.1 / 8.23.1 |                                                                                           |

## Web (installed in T-006, `apps/web`)

| Package                                              | Version                                    | Notes                                                                             |
| ---------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------- |
| react / react-dom                                    | 19.3.1                                     |                                                                                   |
| react-router                                         | 8.5.0                                      | v8: `RouterProvider` from `react-router/dom`, everything else from `react-router` |
| vite                                                 | 8.3.5                                      | dev; Rolldown bundler (native binding per platform)                               |
| @vitejs/plugin-react                                 | 6.1.2                                      | dev                                                                               |
| tailwindcss / @tailwindcss/vite                      | 4.3.3                                      | dev; CSS-first config (`@theme` in `src/index.css`)                               |
| shadcn/ui                                            | CLI-copied components (no package version) | `components.json`; Button and DropdownMenu so far                                 |
| @radix-ui/react-dropdown-menu                        | 2.2.1                                      | shadcn/ui primitive                                                               |
| class-variance-authority / clsx / tailwind-merge     | 0.7.1 / 2.1.1 / 3.7.0                      | shadcn/ui helpers                                                                 |
| lucide-react                                         | 1.61.0                                     | Icons                                                                             |
| @tanstack/react-query                                | 5.104.5                                    |                                                                                   |
| i18next / react-i18next                              | 26.5.5 / 17.1.7                            |                                                                                   |
| vite-plugin-pwa / workbox-window / workbox-build     | 2.0.0 / 7.4.1 / 7.4.1                      |                                                                                   |
| @types/react / @types/react-dom                      | 19.3.0 / 19.3.0                            | dev                                                                               |
| @testing-library/react / dom / user-event / jest-dom | 16.3.3 / 10.4.2 / 14.6.8 / 7.0.1           | dev                                                                               |
| jsdom                                                | 30.1.3                                     | dev; Vitest `web` project                                                         |
| eslint-plugin-react-hooks                            | 7.1.1                                      | root dev                                                                          |

## Stack (planned)

| Package                        | Version | Ticket              |
| ------------------------------ | ------- | ------------------- |
| @asteasolutions/zod-to-openapi | 9.1.0   | T-007               |
| react-hook-form                | 7.90.0  | T-010 (first form)  |
| dexie                          | 4.4.6   | T-093               |
| otplib                         | 13.5.0  | T-011               |
| pg-boss                        | 12.38.0 | T-021               |
| @playwright/test               | 1.64.1  | First E2E journey   |
| astro                          | 7.4.2   | V1.2 booking engine |
