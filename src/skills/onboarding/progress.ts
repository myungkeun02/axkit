import type { FirstLookPhase, FirstLookProgress, FirstLookStatus } from '../../core/contracts/first-look.js';
import type { ProgressEvent } from './runner.js';
import type { RunState, ScanPhase } from './state.js';

type Phase = Exclude<ScanPhase, 'done'>;

const ORDER: readonly Phase[] = ['local', 'projects', 'drive', 'signals', 'profile'];

/** How much of a typical first look each phase takes; a phase with nothing to read counts as done once passed. */
const WEIGHT: Readonly<Record<Phase, number>> = { local: 35, projects: 30, drive: 10, signals: 5, profile: 20 };

const LABEL_KO: Readonly<Record<Phase, string>> = {
  local: '폴더 파일',
  projects: '프로젝트 문서·대화 기록',
  drive: 'Google Drive',
  signals: '메일·캘린더 흐름',
  profile: '정리하기',
};
const LABEL_EN: Readonly<Record<Phase, string>> = {
  local: 'Folder files',
  projects: 'Project docs and sessions',
  drive: 'Google Drive',
  signals: 'Mail and calendar',
  profile: 'Putting it together',
};

export interface ProgressTrackerDeps {
  state: () => RunState;
  running: () => boolean;
  korean: boolean;
}

/**
 * The live first-look snapshot (view `first-look`): the runner's progress events per phase in memory, the run's
 * status, phase and counts from the persisted run state, so a restart still answers sensibly.
 */
export class ProgressTracker {
  private phases = new Map<Phase, { done: number; total: number }>();

  constructor(private readonly deps: ProgressTrackerDeps) {}

  /** A new run starts with empty bars. */
  reset(): void {
    this.phases = new Map();
  }

  record(event: ProgressEvent): void {
    if (!('phase' in event) || event.phase === 'done') return;
    this.phases.set(event.phase, { done: Math.max(0, event.done), total: Math.max(0, event.total, event.done) });
  }

  snapshot(): FirstLookProgress {
    const state = this.deps.state();
    const status = statusOf(state, this.deps.running());
    const finished = status === 'done';
    const current = state.phase === 'done' ? ORDER.length : ORDER.indexOf(state.phase);
    const labels = this.deps.korean ? LABEL_KO : LABEL_EN;
    let percent = 0;
    const phases: FirstLookPhase[] = ORDER.map((id, index) => {
      const seen = this.phases.get(id);
      const passed = finished || index < current;
      const active = !passed && index === current && status !== 'idle';
      const done = seen?.done ?? 0;
      const total = seen?.total ?? 0;
      const fraction = passed ? 1 : active && total > 0 ? Math.min(1, done / total) : 0;
      percent += WEIGHT[id] * fraction;
      return { id, label: labels[id], done: passed && seen === undefined ? 0 : done, total, state: passed ? 'done' : active ? 'active' : 'waiting' };
    });
    return {
      status,
      phase: state.phase,
      phases,
      counts: { ...state.counts },
      percent: finished ? 100 : status === 'idle' ? 0 : Math.min(99, Math.floor(percent)),
      startedAt: state.startedAt ?? null,
      ...(state.finishedAt !== undefined && (status === 'done' || status === 'failed') ? { finishedAt: state.finishedAt } : {}),
      ...(status === 'failed' && state.error !== undefined ? { error: state.error } : {}),
    };
  }
}

/** A run state left "running" by a restart, with nothing running now, is shown as paused. */
function statusOf(state: RunState, running: boolean): FirstLookStatus {
  if (running) return 'running';
  return state.status === 'running' ? 'paused' : state.status;
}
