import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { BotDirectory } from '../../core/contracts/bots.js';
import type { KeyValueStore } from '../../core/store/types.js';
import type { WorkInProgress } from '../../core/contracts/work-in-progress.js';
import type { GitEnv } from './git-ops.js';
import { closeWorktree, commitAll, openWorktree, tail, takeFile } from './git-ops.js';
import type { PieceOutcome, SelfDevDeps } from './job.js';
import { checkAndFix, codingPrompt, readReport } from './job.js';
import type { Piece } from './plan.js';
import { PLAN_FILE, followUpInstructions, pieceInstructions } from './plan.js';

export const SESSIONS_KEY = 'sessions';
const STOP = /^\s*(멈춰|그만|중단|취소|stop)\s*(해|해 줘|해줘|주세요)?\s*[.!]?\s*$/i;

type State = 'running' | 'idle' | 'failed' | 'stopped' | 'closed';

interface Child {
  id: string;
  room: string;
  piece: Piece;
  branch: string;
  dir: string;
  state: State;
  instructions: string;
  done: string[];
  queue: string[];
  controller: AbortController;
  outcome?: PieceOutcome;
  startedAt: string;
}

export interface SessionRecord {
  id: string;
  room: string;
  title: string;
  parent: string;
  state: State | 'interrupted';
  branch: string;
}

export interface ParallelDeps extends GitEnv {
  workDir: string;
  kv: KeyValueStore;
  directory: BotDirectory | undefined;
  /** A line in a room ("ax-dev" or a piece's own room). */
  post: (room: string, text: string) => void;
  coder: SelfDevDeps['coder'];
  checks?: SelfDevDeps['checks'];
  checkLock: NonNullable<SelfDevDeps['checkLock']>;
  group: string;
  /** The lead job's work-board item: each part shows under it in the apps' task panel. */
  lead?: string;
  board?: WorkInProgress;
  /** Counts the parts' coding runs against the day's cap; a reason means none start (the lead does them itself). */
  gate?: (runs: number) => Promise<string | undefined>;
}

/** One check run at a time: parallel sessions share this Mac's CPU and the vitest workers. */
export function createLock(): <T>(work: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve();
  return <T,>(work: () => Promise<T>): Promise<T> => {
    const next = last.then(work, work);
    last = next.catch(() => undefined);
    return next;
  };
}

/**
 * The lead's parallel sessions: each split-off part gets its own room, branch and worktree and runs at the same time.
 * The owner can open a part's room to steer it ("이것도 같이") or stop it ("멈춰"); when a part ends a turn its room
 * gets the report and the lead's room a one-line note. The lead continues once none is still working.
 */
export class ParallelSessions {
  private children: Child[] = [];
  private parent = '';
  private wake: (() => void) | undefined;

  constructor(private readonly deps: ParallelDeps) {}

  /** Rooms of the parts this job opened (routing). */
  owns(room: string): boolean {
    return this.children.some((child) => child.room === room);
  }

  async start(parent: string, request: string, pieces: readonly Piece[], base: string, signal?: AbortSignal): Promise<PieceOutcome[]> {
    this.parent = parent;
    const blocked = await this.deps.gate?.(pieces.length);
    if (blocked !== undefined) {
      this.deps.post(parent, `${blocked} 나눠서 하지 않고 여기서 할게요.`);
      return pieces.map((piece) => ({ piece, status: 'failed' as const, detail: blocked }));
    }
    this.children = [];
    for (const piece of pieces) {
      const id = `sd-${randomUUID().slice(0, 8)}`;
      const room = `ax-dev-${id.slice(3, 9)}`;
      const child: Child = { id, room, piece, branch: `ax-self/${id}`, dir: join(this.deps.workDir, id), state: 'running', instructions: codingPrompt(pieceInstructions(request, piece)), done: [], queue: [], controller: new AbortController(), startedAt: new Date().toISOString() };
      signal?.addEventListener('abort', () => child.controller.abort(), { once: true });
      this.children.push(child);
      await this.deps.directory?.upsert({ id: room, name: `ax 개선 · ${piece.title}`, role: piece.brief.split('\n')[0]?.slice(0, 80) ?? piece.title, group: this.deps.group, kind: 'dev', origin: 'owner', status: 'working' }).catch(() => undefined);
    }
    this.deps.post(parent, `이 요청은 나눠서 동시에 하는 게 빨라서 하위 작업 ${pieces.length}개를 열었어요. 각 방에서 진행을 보거나 더 말하거나 멈출 수 있어요:\n${this.children.map((child) => `• ${child.piece.title} → 'ax 개선 · ${child.piece.title}' 방`).join('\n')}`);
    await this.save();
    const settled = new Promise<void>((resolve) => (this.wake = resolve));
    for (const child of this.children) {
      this.deps.post(child.room, `'ax 개선' 방에서 나눠 받은 작업이에요: ${child.piece.title}\n${child.piece.brief}\n\n시작할게요. 여기에 말하면 이 작업에 이어서 반영하고, '멈춰'라고 하면 멈춰요.`);
      void this.turn(child, base, child.instructions);
    }
    this.check();
    await settled;
    return this.children.map((child) => child.outcome ?? { piece: child.piece, status: 'stopped', detail: '' });
  }

  /** A message in a part's room: a stop, a follow-up for its next turn, or a note that it is already merged. */
  async message(room: string, text: string): Promise<string> {
    const child = this.children.find((item) => item.room === room);
    if (child === undefined || child.state === 'closed') return '이 작업은 이미 합쳐서 끝났어요. 더 바꿀 게 있으면 \'ax 개선\' 방에서 말씀해 주세요.';
    if (STOP.test(text)) {
      if (child.state !== 'running') return '지금 하고 있는 일은 없어요.';
      child.controller.abort();
      child.state = 'stopped';
      child.outcome = { piece: child.piece, status: 'stopped', detail: '주인이 멈췄어요.' };
      this.deps.post(this.parent, `[하위 작업 '${child.piece.title}'] 멈췄어요. 이 부분은 빼고 합칠게요.`);
      await this.mark(child, 'idle', '멈춤');
      this.check();
      return '멈췄어요. 이 부분은 빼고 합칠게요.';
    }
    if (child.state === 'running') {
      child.queue.push(text);
      return '지금 하는 중이에요. 이번 차례가 끝나면 바로 이어서 반영할게요.';
    }
    if (child.state === 'stopped') return '멈춘 작업이에요. 다시 하려면 \'ax 개선\' 방에서 새로 말씀해 주세요.';
    void this.turn(child, undefined, followUpInstructions(child.instructions, child.done, text));
    return '이어서 반영할게요.';
  }

  status(): string[] {
    const label: Record<State, string> = { running: '하는 중', idle: '끝남', failed: '실패', stopped: '멈춤', closed: '합침' };
    return this.children.map((child) => `• ${child.piece.title}: ${label[child.state]}`);
  }

  /** After the lead merged (or gave up): rooms stay as history, worktrees go, branches stay when nothing was applied. */
  async close(applied: boolean): Promise<void> {
    for (const child of this.children) {
      child.controller.abort();
      child.state = 'closed';
      await closeWorktree(this.deps, child.dir, child.branch, !applied);
      await this.mark(child, 'idle', applied ? '합쳐서 적용됨' : '적용 안 됨');
    }
    await this.save();
  }

  private async turn(child: Child, base: string | undefined, instructions: string): Promise<void> {
    child.state = 'running';
    const signal = child.controller.signal;
    await this.mark(child, 'working', '하는 중');
    const outcome = await this.work(child, base, instructions, signal).catch((error: unknown): PieceOutcome => ({ piece: child.piece, status: 'failed', detail: error instanceof Error ? error.message : String(error) }));
    if (child.state !== 'running') return;
    child.outcome = outcome;
    if (outcome.status === 'done') {
      child.state = 'idle';
      child.done.push(outcome.summary);
      this.deps.post(child.room, `끝났어요 ✓ (검사 통과)\n${outcome.summary}${outcome.needs !== '' ? `\n\n사람이 할 일:\n${outcome.needs}` : ''}`);
      this.deps.post(this.parent, `[하위 작업 '${child.piece.title}'] 끝났어요 ✓ ${outcome.summary.split('\n')[0]?.slice(0, 160) ?? ''}`);
    } else {
      child.state = 'failed';
      this.deps.post(child.room, `끝내지 못했어요.\n${tail(outcome.status === 'failed' ? outcome.detail : '').slice(-1200)}`);
      this.deps.post(this.parent, `[하위 작업 '${child.piece.title}'] 끝내지 못했어요. 이 부분은 합칠 때 직접 할게요.`);
    }
    await this.mark(child, 'idle', child.state === 'idle' ? '끝남' : '실패');
    const queued = child.queue.splice(0);
    if (queued.length > 0 && child.state === 'idle') return void this.turn(child, undefined, followUpInstructions(child.instructions, child.done, queued.join('\n')));
    this.check();
  }

  private async work(child: Child, base: string | undefined, instructions: string, signal: AbortSignal): Promise<PieceOutcome> {
    if (base !== undefined) {
      const opened = await openWorktree(this.deps, child.dir, child.branch, base);
      if (!opened.ok) return { piece: child.piece, status: 'failed', detail: opened.out };
    }
    const progress = (line: string): void => this.deps.post(child.room, line);
    progress('코드를 고치는 중이에요…');
    const coded = await this.deps.coder.write({ dir: child.dir, instructions, signal });
    await takeFile(child.dir, PLAN_FILE);
    if (!coded.ok) return { piece: child.piece, status: 'failed', detail: tail(coded.log) };
    const checked = await checkAndFix({ run: this.deps.run, coder: this.deps.coder, checkLock: this.deps.checkLock, progress, ...(this.deps.checks !== undefined ? { checks: this.deps.checks } : {}) }, child.dir, instructions, readReport(coded.log), signal);
    if (!checked.ok) return { piece: child.piece, status: 'failed', detail: checked.detail };
    const committed = await commitAll(this.deps, child.dir, `ax 개선(하위): ${child.piece.title}`);
    if (typeof committed === 'object') return { piece: child.piece, status: 'failed', detail: committed.error };
    return { piece: child.piece, status: 'done', branch: child.branch, ...checked.report };
  }

  /** The lead goes on once no part is working and none has a follow-up waiting. */
  private check(): void {
    if (this.wake === undefined || this.children.some((child) => child.state === 'running' || child.queue.length > 0)) return;
    const wake = this.wake;
    this.wake = undefined;
    wake();
  }

  private async mark(child: Child, status: 'working' | 'idle', text: string): Promise<void> {
    await this.deps.directory?.setStatus(child.room, status, text).catch(() => undefined);
    await this.save();
    const now = new Date().toISOString();
    const work = { running: 'running', idle: 'done', failed: 'failed', stopped: 'interrupted', closed: 'done' } as const;
    await this.deps.board
      ?.upsert({ id: `self-dev:${child.id}`, kind: 'dev', title: `하위 작업 · ${child.piece.title}`, status: work[child.state], phase: text, startedAt: child.startedAt, updatedAt: now, origin: { channelId: 'channel.app', address: `bot:${child.room}` }, ...(this.deps.lead !== undefined ? { parent: this.deps.lead } : {}) })
      .catch(() => undefined);
  }

  private async save(): Promise<void> {
    const records: SessionRecord[] = this.children.map((child) => ({ id: child.id, room: child.room, title: child.piece.title, parent: this.parent, state: child.state, branch: child.branch }));
    const old = ((await this.deps.kv.get<SessionRecord[]>(SESSIONS_KEY)) ?? []).filter((record) => !records.some((item) => item.id === record.id));
    await this.deps.kv.set(SESSIONS_KEY, [...old, ...records].slice(-40));
  }
}
