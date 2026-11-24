import { describe, expect, it } from 'vitest';
import type {
  FolderScan,
  FolderWalk,
  Notice,
  NoticeResult,
  Notifier,
  RepoDetails,
} from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { IncomingMessage, MessageHandler, OutgoingMessage, Replier } from '../../../src/core/conversation/types.js';
import type { PluginInstance } from '../../../src/core/plugin/types.js';
import { onboardingSkill } from '../../../src/skills/onboarding/plugin.js';
import type { RunState } from '../../../src/skills/onboarding/state.js';
import { createTestContext } from '../../support/context.js';
import { flush } from '../../core/helpers.js';
import { BehaviorLlm, NOW, profileJson } from './helpers.js';

class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];

  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return 'sent';
  }
}

const EMPTY_WALK: FolderWalk = { files: [], repos: [], truncated: false };

class GatedScan implements FolderScan {
  walks = 0;
  private release: (() => void) | undefined;

  async walk(): Promise<FolderWalk> {
    this.walks += 1;
    if (this.walks === 1) {
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    return EMPTY_WALK;
  }

  async excerpt(): Promise<string> {
    return '';
  }

  async repo(): Promise<RepoDetails> {
    return { commits: [], languages: [] };
  }

  releaseGate(): void {
    this.release?.();
  }
}

async function eventually(predicate: () => Promise<boolean> | boolean): Promise<void> {
  for (let index = 0; index < 200; index += 1) {
    if (await predicate()) return;
    await flush();
  }
  throw new Error('condition was not met');
}

async function setup(
  options: {
    config?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
    seed?: Record<string, unknown>;
  } = {},
) {
  const notifier = new FakeNotifier();
  const context = createTestContext({
    now: NOW,
    llm: new BehaviorLlm(() => profileJson({})),
    config: { autoStart: false, drive: false, signals: false, ...(options.config ?? {}) },
    capabilities: {
      [Contracts.notifier.id]: notifier,
      ...(options.capabilities ?? {}),
    },
  });
  if (options.seed !== undefined) await context.kv.set('run', options.seed);
  const instance = await onboardingSkill().setup(context.ctx);
  return { context, notifier, instance };
}

type Context = Awaited<ReturnType<typeof setup>>['context'];

function handlerOf(context: Context): MessageHandler {
  const found = context.handlers.find((handler) => handler.id === 'onboarding.controls');
  if (found === undefined) throw new Error('No onboarding handler');
  return found;
}

function message(text: string, fromOwner = true): IncomingMessage {
  return {
    id: 'm1',
    conversation: { channelId: 'c1', address: 'a1' },
    authorId: fromOwner ? 'owner' : 'other',
    fromOwner,
    text,
    receivedAt: NOW,
  };
}

async function send(context: Context, text: string, fromOwner = true) {
  const replies: OutgoingMessage[] = [];
  const replier: Replier = {
    async reply(_to, outgoing) {
      replies.push(outgoing);
    },
  };
  const result = await handlerOf(context).handle(message(text, fromOwner), replier);
  return { result, replies };
}

function preview(room: string, text: string, ref = room) {
  return {
    app: 'kakao' as const,
    room,
    text,
    unread: null,
    at: NOW,
    ref,
  };
}

async function runStateOf(context: Context): Promise<RunState | undefined> {
  return context.kv.get<RunState>('run');
}

describe('chat room buffer', () => {
  it('keeps room titles and counts but never the message text', async () => {
    const { context } = await setup();

    await context.bus.emit('chat.preview', preview('가족', '아주 비밀스러운 메시지'));
    await context.bus.emit('chat.preview', preview('가족', '또 비밀'));
    await context.bus.emit('chat.preview', preview('팀', '회의 시작'));

    const rooms = await context.kv.get<Record<string, unknown>>('rooms');
    expect(Object.keys(rooms ?? {}).sort()).toEqual(['가족', '팀']);
    expect(rooms?.['가족']).toEqual({ count: 2, lastAt: NOW.toISOString() });
    expect(rooms?.['팀']).toEqual({ count: 1, lastAt: NOW.toISOString() });
    expect(JSON.stringify(rooms)).not.toContain('비밀');
    expect(JSON.stringify(rooms)).not.toContain('회의 시작');
  });

  it('stops adding new rooms at 200', async () => {
    const { context } = await setup();

    for (let index = 0; index < 201; index += 1) {
      await context.bus.emit('chat.preview', preview(`room-${index}`, '내용', `ref-${index}`));
    }

    const rooms = await context.kv.get<Record<string, unknown>>('rooms');
    expect(Object.keys(rooms ?? {})).toHaveLength(200);
    expect(rooms?.['room-199']).toBeDefined();
    expect(rooms?.['room-200']).toBeUndefined();
  });
});

describe('auto start and daily job', () => {
  it('starts the first look on app.started and announces progress', async () => {
    const { context, notifier } = await setup({ config: { autoStart: true } });

    await context.bus.emit('app.started', { at: NOW });

    await eventually(async () => (await runStateOf(context))?.status === 'done');
    const state = await runStateOf(context);
    expect(state?.reason).toBe('first');
    expect(state?.firstDoneAt).toBeDefined();
    const finished = notifier.notices.find(
      (notice) => notice.kind === 'onboarding.done' && notice.text.includes('끝났어요'),
    );
    expect(finished).toBeDefined();
    expect(finished?.dedupeKey).toContain(':finished');
  });

  it('runs the daily job silently after the first look', async () => {
    const { context, notifier } = await setup({
      seed: {
        status: 'done',
        phase: 'done',
        firstDoneAt: NOW.toISOString(),
        counts: { files: 0, repos: 0, drive: 0, summarized: 0, signals: 0 },
      },
    });

    await context.scheduler.run('onboarding.daily');

    await eventually(async () => {
      const state = await runStateOf(context);
      return state?.reason === 'daily' && state.status === 'done';
    });
    expect(notifier.notices).toEqual([]);
  });

  it('records and announces a run that failed before the runner could catch it', async () => {
    const { context, notifier } = await setup({ config: { autoStart: true } });
    const set = context.kv.set.bind(context.kv);
    let broken = true;
    context.kv.set = async <T,>(key: string, value: T): Promise<void> => {
      if (broken && key === 'run') {
        broken = false;
        throw new Error('disk full');
      }
      await set(key, value);
    };

    await context.bus.emit('app.started', { at: NOW });

    await eventually(async () => (await runStateOf(context))?.status === 'failed');
    await eventually(() => notifier.notices.some((notice) => notice.kind === 'onboarding.failed'));
    const started = await send(context, '처음 알아보기');
    expect(started.replies[0]?.text).toBe('알아보기 시작할게요. 끝나면 알려 드릴게요.');
  });

  it('does not run the daily job before the first look finished', async () => {
    const { context } = await setup();

    await context.scheduler.run('onboarding.daily');
    await flush();

    const state = await runStateOf(context);
    expect(state).toBeUndefined();
  });
});

describe('handlers', () => {
  it('starts, reports already running, stops, resumes and reports status', async () => {
    const gated = new GatedScan();
    const { context } = await setup({
      config: { folders: ['~/work'] },
      capabilities: { [Contracts.folderScan.id]: { open: () => gated } },
    });

    const status = await send(context, '알아보기 상태');
    expect(status.result).toBe('handled');
    expect(status.replies[0]?.text).toContain('아직 안 함');

    const started = await send(context, '처음 알아보기');
    expect(started.replies[0]?.text).toBe('알아보기 시작할게요. 끝나면 알려 드릴게요.');
    await eventually(async () => (await runStateOf(context))?.status === 'running');

    const again = await send(context, '처음 알아보기');
    expect(again.replies[0]?.text).toBe('이미 알아보는 중이에요.');

    const stopped = await send(context, '알아보기 멈춰');
    expect(stopped.replies[0]?.text).toContain('알아보기를 멈췄어요.');

    gated.releaseGate();
    await eventually(async () => (await runStateOf(context))?.status === 'paused');
    await flush();

    const resumed = await send(context, '알아보기 계속');
    expect(resumed.replies[0]?.text).toBe('멈춘 곳부터 다시 알아볼게요.');
    await eventually(async () => (await runStateOf(context))?.status === 'done');

    const done = await send(context, '알아보기 상태');
    expect(done.replies[0]?.text).toContain('끝남');

    const idleStop = await send(context, '알아보기 멈춰');
    expect(idleStop.replies[0]?.text).toBe('지금 알아보는 중이 아니에요.');
    const idleResume = await send(context, '알아보기 계속');
    expect(idleResume.replies[0]?.text).toContain('이어서 할 알아보기가 없어요');
  });

  it('ignores non-owners and unrelated messages', async () => {
    const { context } = await setup();

    expect((await send(context, '처음 알아보기', false)).result).toBe('pass');
    expect((await send(context, '오늘 뭐 해?')).result).toBe('pass');
  });

  it('lets plugin stop abort a running scan', async () => {
    const gated = new GatedScan();
    const { context, instance } = await setup({
      config: { autoStart: true, folders: ['~/work'] },
      capabilities: { [Contracts.folderScan.id]: { open: () => gated } },
    });

    await context.bus.emit('app.started', { at: NOW });
    await eventually(async () => (await runStateOf(context))?.status === 'running');

    await (instance as PluginInstance | undefined)?.stop?.();
    gated.releaseGate();

    await eventually(async () => (await runStateOf(context))?.status === 'paused');
  });
});

describe('status tool', () => {
  it('reports the run state and cache size', async () => {
    const { context } = await setup({
      config: { autoStart: true },
    });
    await context.bus.emit('app.started', { at: NOW });
    await eventually(async () => (await runStateOf(context))?.status === 'done');

    const outcome = await context.ctx.tools.execute('onboarding.status', {});

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' ? outcome.output : undefined).toMatchObject({
      status: 'done',
      phase: 'done',
      counts: { files: 0, repos: 0, drive: 0, summarized: 0, signals: 0 },
      summaries: 0,
      reason: 'first',
    });
  });
});
