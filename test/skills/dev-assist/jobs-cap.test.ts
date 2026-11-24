import { describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { JobStore } from '../../../src/skills/dev-assist/jobs.js';
import { MAX_JOBS } from '../../../src/skills/dev-assist/types.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { makeJob } from './helpers.js';

describe('JobStore cap', () => {
  it('evicts only finished jobs, never queued or running ones', async () => {
    const store = new JobStore(new MapKeyValueStore(), silentLogger);
    await store.load();
    await store.add(makeJob({ id: 'job_queued', status: 'queued' }));
    await store.add(makeJob({ id: 'job_running', status: 'running' }));
    for (let i = 0; i < MAX_JOBS; i += 1) await store.add(makeJob({ id: `job_done${i}`, status: 'ready' }));

    expect(store.all()).toHaveLength(MAX_JOBS);
    expect(store.get('job_queued')?.status).toBe('queued');
    expect(store.get('job_running')?.status).toBe('running');
    expect(store.get('job_done0')).toBeUndefined();
  });

  it('keeps unfinished jobs when loading an oversized list', async () => {
    const kv = new MapKeyValueStore();
    const jobs = [
      ...Array.from({ length: MAX_JOBS }, (_, i) => makeJob({ id: `job_done${i}`, status: 'ready' })),
      makeJob({ id: 'job_old_running', status: 'running' }),
    ];
    await kv.set('jobs', jobs);
    const store = new JobStore(kv, silentLogger);
    await store.load('2026-11-23T00:00:00.000Z');
    expect(store.all()).toHaveLength(MAX_JOBS);
    expect(store.get('job_old_running')?.status).toBe('interrupted');
  });
});
