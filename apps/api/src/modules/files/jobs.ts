import type { FileScanner } from '../../core/file-scan.ts';
import type { FileStore } from '../../core/files.ts';
import { defineJob } from '../../core/jobs.ts';
import { scanPendingFiles } from './service.ts';

/**
 * Tab 2 "Files": the worker scans uploads and marks them CLEAN (or INFECTED). Every minute,
 * so a file is usually ready within a minute of its upload.
 */
export function fileScanJob(deps: { store: FileStore; scanner: FileScanner }) {
  return defineJob({
    name: 'file-scan',
    schedule: { cron: '* * * * *' },
    async run(_data, { db, clock, logger }) {
      const summary = await scanPendingFiles({ ...deps, db, clock, logger });
      if (summary.clean + summary.blocked + summary.abandoned > 0) {
        logger.info(summary, 'Files scanned');
      }
    },
  });
}
