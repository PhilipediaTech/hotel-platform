// `npm run dev`: runs every app's dev server side by side with prefixed output (runbook §1).
// Add the worker (T-021) and site (V1.2) here when they exist.
import { spawn } from 'node:child_process';

const APPS = [
  { name: 'api', workspace: 'apps/api', colour: 36 }, // cyan, :4000
  { name: 'web', workspace: 'apps/web', colour: 35 }, // magenta, :5173
];

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('Run this through npm: `npm run dev`.');
  process.exit(1);
}

/** @param {string} prefix @param {NodeJS.WriteStream} out */
function prefixed(prefix, out) {
  let pending = '';
  return (/** @type {Buffer} */ chunk) => {
    const lines = (pending + chunk.toString()).split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) out.write(`${prefix} ${line}\n`);
  };
}

const children = APPS.map(({ name, workspace, colour }) => {
  const prefix = `\x1b[${colour}m[${name}]\x1b[0m`;
  const child = spawn(process.execPath, [npmCli, 'run', 'dev', '-w', workspace], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  child.stdout.on('data', prefixed(prefix, process.stdout));
  child.stderr.on('data', prefixed(prefix, process.stderr));
  child.on('exit', (code) => {
    console.error(`${prefix} exited with code ${code ?? 'signal'}; stopping the others.`);
    shutdown(code ?? 1);
  });
  return child;
});

let stopping = false;
/** @param {number} code */
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  setTimeout(() => process.exit(code), 500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
