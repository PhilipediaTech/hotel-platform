import { cleanupJob } from './core/cleanup.ts';
import type { JobDefinition } from './core/jobs.ts';
import type { EventHandler } from './core/outbox.ts';

// Everything the worker runs. Modules add their scheduled jobs and outbox handlers here.

export const JOBS: readonly JobDefinition<never>[] = [cleanupJob];

export const EVENT_HANDLERS: readonly EventHandler[] = [];
