import { describe, expect, it } from 'vitest';
import { ProgressTracker } from '../../../src/skills/onboarding/progress.js';
import { RunStateStore } from '../../../src/skills/onboarding/state.js';
import { MapKeyValueStore } from '../../core/helpers.js';

const AT = '2026-11-23T00:00:00.000Z';

describe('first-look progress snapshot', () => {
  it('follows the run through its phases with per-phase counts and a weighted percent', async () => {
    const state = new RunStateStore(new MapKeyValueStore());
    await state.load();
    let running = false;
    const tracker = new ProgressTracker({ state: () => state.current, running: () => running, korean: true });
    expect(tracker.snapshot()).toMatchObject({ status: 'idle', percent: 0, startedAt: null });

    running = true;
    tracker.reset();
    await state.begin('first', AT);
    tracker.record({ phase: 'local', done: 0, total: 400 });
    tracker.record({ phase: 'local', done: 200, total: 400 });
    let snap = tracker.snapshot();
    expect(snap.status).toBe('running');
    expect(snap.phases[0]).toEqual({ id: 'local', label: '폴더 파일', done: 200, total: 400, state: 'active' });
    expect(snap.phases[1]?.state).toBe('waiting');
    expect(snap.percent).toBe(17);
    expect(snap.startedAt).toBe(AT);

    tracker.record({ phase: 'local', done: 400, total: 400 });
    await state.setPhase('projects');
    tracker.record({ phase: 'projects', done: 12, total: 40 });
    snap = tracker.snapshot();
    expect(snap.phases.map((phase) => phase.state)).toEqual(['done', 'active', 'waiting', 'waiting', 'waiting']);
    expect(snap.phases[1]).toMatchObject({ label: '프로젝트 문서·대화 기록', done: 12, total: 40 });
    expect(snap.percent).toBe(44);

    await state.setPhase('drive');
    tracker.record({ phase: 'drive', done: 0, total: 0 });
    await state.setPhase('profile');
    tracker.record({ phase: 'profile', done: 0, total: 1 });
    expect(tracker.snapshot().percent).toBe(80);

    await state.finish('2026-11-23T00:10:00.000Z', { files: 400, repos: 1, drive: 0, summarized: 300, signals: 3, docs: 10, sessions: 30 }, true);
    running = false;
    snap = tracker.snapshot();
    expect(snap).toMatchObject({ status: 'done', phase: 'done', percent: 100, finishedAt: '2026-11-23T00:10:00.000Z' });
    expect(snap.counts['sessions']).toBe(30);
    expect(snap.phases.every((phase) => phase.state === 'done')).toBe(true);
  });

  it('reports a run left "running" by a restart as paused, and a failure with its error', async () => {
    const state = new RunStateStore(new MapKeyValueStore());
    await state.begin('first', AT);
    const tracker = new ProgressTracker({ state: () => state.current, running: () => false, korean: false });
    expect(tracker.snapshot().status).toBe('paused');
    expect(tracker.snapshot().phases[0]?.label).toBe('Folder files');
    await state.fail('model_unavailable', AT);
    expect(tracker.snapshot()).toMatchObject({ status: 'failed', error: 'model_unavailable', finishedAt: AT });
  });
});
