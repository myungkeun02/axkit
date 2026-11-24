import type { KeyValueStore } from '../store/types.js';
import type { JobRun, JobRunStore } from './types.js';

/** One key per job in a core kv namespace: only the last run is kept. */
export class KvJobRuns implements JobRunStore {
  constructor(private readonly kv: KeyValueStore) {}

  async read(name: string): Promise<JobRun | undefined> {
    const value = await this.kv.get<JobRun>(`run:${name}`);
    return value !== undefined && typeof value.startedAt === 'string' ? value : undefined;
  }

  async write(name: string, run: JobRun): Promise<void> {
    await this.kv.set(`run:${name}`, run);
  }
}
