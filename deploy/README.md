# Deploying (T-005 staging, T-103 production)

What's in the repo already, ready for when the accounts exist (runbook tab 9):

| File                                      | What it is                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `render.yaml`                             | Production on Render: API, worker, PostgreSQL 18, Frankfurt. Deploys only from a tag.                                                                               |
| `render.staging.yaml`                     | Staging: the same in production mode, deploying every push to `main`, test keys only, its own database.                                                             |
| `.github/workflows/deploy-production.yml` | Push a `v*` tag on the head of `main`. It checks CI passed, waits for a person to approve, then calls the deploy hooks.                                             |
| `apps/web` build → `dist/_headers`        | The staff app's CSP, HSTS and other headers for Cloudflare Pages (`src/security-headers.ts`). `npm run preview -w apps/web` serves the build with the same headers. |
| `deploy/environments.json`                | Public URLs per environment (null until the domain exists) and the Render service names.                                                                            |

`scripts/deploy-config.test.ts` checks all of this in CI:

- the blueprints declare every variable the API reads;
- no secret value is committed;
- the Node version matches `.nvmrc`;
- the fixed values load as a valid production config;
- staging and production share nothing.

## Before staging can start

The API refuses to start in production mode until it has its production adapters. Both staging and production run in production mode on purpose. Each adapter is built once its account exists:

1. **Email: AWS SES** (London, eu-west-2). The domain has to be verified first.
2. **Files: Cloudflare R2**, with a private bucket and an API token scoped to it.
3. **Virus scanning:** the engine is still to be chosen (spec issue 9).

## Philip's checklist (accounts and money, in this order)

Each step costs money or creates an account, so it's yours. Secrets go only in the Render, Cloudflare and GitHub dashboards, never in chat or in git.

1. **Domain:** register it, then move its DNS to Cloudflare. Hostnames: `app.`, `api.`, `www.` and `book.`. For staging, use `staging-app.` and `staging-api.` on the same domain: the session cookie only works when the app and API share a domain, so the free `onrender.com` and `pages.dev` addresses won't do.
2. **Render:** create the account (MFA on). Then New → Blueprint → this repo → `render.staging.yaml`. Check the plan names and prices on the screen before you confirm. Enter each `sync: false` value; the comments in the file say what each one is.
3. **Cloudflare Pages** (staff app):
   - connect the repo;
   - build command `npm ci && npm run build -w apps/web`;
   - output folder `apps/web/dist`;
   - environment variable `VITE_API_BASE_URL=https://staging-api.<domain>/api/v1`;
   - custom domain `staging-app.<domain>`.
4. **AWS SES and Cloudflare R2:** create both accounts, then tell me. I'll build the two adapters, and staging can start.
5. **Production (T-103):** the same steps with `render.yaml`. Then in GitHub, Settings → Environments → `production`: add yourself as a required reviewer, and add the secrets `RENDER_DEPLOY_HOOK_API`, `RENDER_DEPLOY_HOOK_WORKER` and `CF_PAGES_DEPLOY_HOOK_WEB`.

## Differences from the runbook

- The web app reads `VITE_API_BASE_URL`, not `VITE_API_URL`, because that's the name in `apps/web/src/lib/api.ts`.
- There's no `RUN_JOBS_IN_WEB` yet, so the worker is its own Render service.
- `COOKIE_DOMAIN` stays unset. The session cookie belongs to the API host only. `app.` and `api.` count as the same site, so the browser still sends it. A parent-domain cookie would be shared between staging and production.
- The marketing and booking site (`apps/site`) has no build yet, so it has no Pages project.
