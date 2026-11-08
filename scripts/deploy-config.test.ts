import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENV_VARIABLES, loadConfig } from '../apps/api/src/core/config.ts';

// Deploy configuration (T-005; runbook tab 9). The Render blueprints, the production deploy
// workflow and deploy/environments.json are checked here, because nothing else exercises them
// until accounts exist. The blueprints are read as text (no YAML dependency for two files).

const root = new URL('../', import.meta.url);
const read = (file: string) => readFileSync(new URL(file, root), 'utf8');

const BLUEPRINTS = {
  production: read('render.yaml'),
  staging: read('render.staging.yaml'),
};

/** Set by Render itself, or with a default that suits hosting. */
const NOT_IN_BLUEPRINT = new Set([
  'PORT', // Render sets it
  'COOKIE_DOMAIN', // host-only cookie on the API host (app. and api. are same-site)
  'LOCAL_FILES_DIR', // the local file store never runs in production
  'PAYMENT_WEBHOOK_SECRET', // Paystack signs with the secret key by default
  'WHATSAPP_GRAPH_VERSION', // pinned in code
]);

const SECRET = /SECRET|_KEY$|TOKEN|PASSWORD$/;

/** `- key: NAME` entries with what follows them (`value: …`, `sync: false`, `fromDatabase`). */
function envEntries(yaml: string): Map<string, string> {
  const entries = new Map<string, string>();
  const lines = yaml.split('\n');
  lines.forEach((line, i) => {
    const key = /^\s*- key: ([A-Z_]+)\s*$/.exec(line)?.[1];
    if (key) entries.set(key, (lines[i + 1] ?? '').trim());
  });
  return entries;
}

function literalValues(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, next] of envEntries(yaml)) {
    const value = /^value: (.+)$/.exec(next)?.[1];
    if (value) out[key] = value.replace(/^['"]|['"]$/g, '');
  }
  return out;
}

describe.each(Object.entries(BLUEPRINTS))('%s blueprint', (name, yaml) => {
  const entries = envEntries(yaml);

  it('declares every variable the API reads', () => {
    const missing = ENV_VARIABLES.filter((v) => !NOT_IN_BLUEPRINT.has(v) && !entries.has(v));
    expect(missing).toEqual([]);
    const unknown = [...entries.keys()].filter(
      (k) => !ENV_VARIABLES.includes(k) && k !== 'NODE_VERSION',
    );
    expect(unknown, 'a variable the API does not read').toEqual([]);
  });

  it('commits no secret: every secret is typed in the Render dashboard', () => {
    const committed = [...entries]
      .filter(([key]) => SECRET.test(key) && key !== 'PASSWORD_BREACH_CHECK')
      .filter(([, next]) => next !== 'sync: false');
    expect(committed).toEqual([]);
  });

  it('runs the Node version of .nvmrc, in production mode, in Frankfurt', () => {
    const values = literalValues(yaml);
    expect(values['NODE_VERSION']).toBe(read('.nvmrc').trim());
    expect(values['NODE_ENV']).toBe('production');
    expect(yaml.match(/region: (\w+)/g)?.every((r) => r === 'region: frankfurt')).toBe(true);
  });

  it('with the dashboard secrets filled in, loads as a valid production config', () => {
    const secret = Buffer.alloc(32, 3).toString('base64url');
    const config = loadConfig({
      ...literalValues(yaml),
      APP_ORIGIN: 'https://app.example.com',
      SITE_ORIGIN: 'https://www.example.com',
      DATABASE_URL: 'postgresql://u:p@db:5432/hotel',
      SESSION_SECRET: `${name}-session-secret-0123456789abcdef`,
      MFA_ENCRYPTION_KEY: secret,
      ID_ENCRYPTION_KEY: secret,
      PAYMENT_SECRET_KEY: name === 'production' ? 'sk_live_abc123' : 'sk_test_abc123',
      WHATSAPP_TOKEN: 'EAAtest-token-0123456789',
      WHATSAPP_PHONE_NUMBER_ID: '1234567890',
    });
    expect(config).toMatchObject({
      nodeEnv: 'production',
      cookieSecure: true,
      passwordBreachCheck: 'hibp',
      payments: { provider: 'paystack' },
      whatsapp: { provider: 'meta' },
    });
  });

  it('migrates before the API starts, and checks /health', () => {
    expect(yaml).toContain('preDeployCommand: npx --no-install prisma migrate deploy');
    expect(yaml).toContain('healthCheckPath: /health');
    expect(yaml).toContain('startCommand: npm run start -w apps/api');
    expect(yaml).toContain('startCommand: npm run start:worker -w apps/api');
  });
});

describe('environments', () => {
  it('deploys production only from a tag, staging on every push to main', () => {
    expect(BLUEPRINTS.production.match(/autoDeploy: (\w+)/g)).toEqual([
      'autoDeploy: false',
      'autoDeploy: false',
    ]);
    expect(BLUEPRINTS.staging.match(/autoDeploy: (\w+)/g)).toEqual([
      'autoDeploy: true',
      'autoDeploy: true',
    ]);
  });

  it('keeps staging and production apart (services and databases)', () => {
    const names = (yaml: string) =>
      yaml.match(/^\s+(?:- )?name: ([\w-]+)$/gm)?.map((l) => l.trim());
    const shared = (names(BLUEPRINTS.production) ?? []).filter((n) =>
      (names(BLUEPRINTS.staging) ?? []).includes(n),
    );
    expect(shared).toEqual([]);
  });

  it('names the same services as the blueprints', () => {
    const envs = JSON.parse(read('deploy/environments.json')) as Record<
      string,
      { render: Record<string, string> }
    >;
    for (const [env, file] of [
      ['production', 'render.yaml'],
      ['staging', 'render.staging.yaml'],
    ] as const) {
      const { blueprint, ...services } = envs[env]?.render ?? {};
      expect(blueprint).toBe(file);
      for (const service of Object.values(services)) {
        expect(read(file)).toMatch(new RegExp(`name: ${service}\\s*$`, 'm'));
      }
    }
  });

  it('the production workflow needs a v* tag on main, passing CI and an approval', () => {
    const workflow = read('.github/workflows/deploy-production.yml');
    expect(workflow).toContain("tags: ['v*']");
    expect(workflow).toContain('environment: production');
    expect(workflow).toContain('Tag is the head of main');
    expect(workflow).toContain('CI passed on this commit');
  });
});
