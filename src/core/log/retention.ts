import type { Clock, Job } from '../scheduler/types.js';
import type { Logger } from './types.js';

const DAY_MS = 86_400_000;

export interface Prunable {
  prune(before: Date): number;
}

export interface RetentionOptions {
  usage: Prunable;
  audit: Prunable;
  usageDays: number;
  auditDays: number;
  clock: Clock;
  log: Logger;
}

/** Daily job that keeps the usage ledger and the audit log bounded. Budget math needs only this month. */
export function retentionJob(options: RetentionOptions): Job {
  return {
    name: 'core.retention',
    schedule: { kind: 'daily', at: '04:10' },
    async run() {
      const now = options.clock.now().getTime();
      const usage = options.usage.prune(new Date(now - options.usageDays * DAY_MS));
      const audit = options.audit.prune(new Date(now - options.auditDays * DAY_MS));
      if (usage > 0 || audit > 0) options.log.info('retention: pruned old rows', { usage, audit });
    },
  };
}
