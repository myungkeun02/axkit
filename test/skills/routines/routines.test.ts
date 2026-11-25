import { describe, expect, it } from 'vitest';
import type { Notice } from '../../../src/core/contracts/notify.js';
import type { LlmGateway, LlmProvider, LlmRequest, LlmResponse } from '../../../src/core/llm/types.js';
import { KvBotDirectory } from '../../../src/core/bots/directory.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import type { PluginContext } from '../../../src/core/plugin/types.js';
import { TimerScheduler } from '../../../src/core/scheduler/scheduler.js';
import { assistantSkill } from '../../../src/skills/assistant/plugin.js';
import { routinesSkill } from '../../../src/skills/routines/plugin.js';
import { dueOn, scheduleFromText, scheduleLabel } from '../../../src/skills/routines/schedule.js';
import { routineScheduleSchema } from '../../../src/skills/routines/schedule.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { createTestContext } from '../../support/context.js';
import { api, events, pairApp, startApp, until } from '../../channels/app/harness.js';

const HOUR = 3_600_000;
const TEMPLATE = 'You are {{persona}}. {{tools}}';
const plan = (reply: string, calls: { name: string; args: Record<string, unknown> }[] = []): string =>
  JSON.stringify({ reply, tool_calls: calls.map((call) => ({ ...call, why: null })), question: null });

/** Answers from a queue first, then from `fallback`. */
class FakeLlm implements LlmGateway {
  readonly requests: LlmRequest[] = [];
  readonly queue: string[] = [];
  constructor(public fallback: (req: LlmRequest) => string) {}
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const text = this.queue.shift() ?? this.fallback(request);
    return { text, providerId: 'fake', model: 'fake', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
}

async function setup(fallback: (req: LlmRequest) => string = () => plan('메일 3개를 정리했어요.')) {
  const llm = new FakeLlm(fallback);
  const notices: Notice[] = [];
  const work: { title: string; kind: string; bot?: { id: string } }[] = [];
  const test = createTestContext({ llm, now: new Date('2026-11-17T08:00:00+09:00') });
  const directory = new KvBotDirectory(new MapKeyValueStore(), () => test.clock.now());
  test.provided.set(Contracts.notifier.id, { notify: async (notice: Notice) => (notices.push(notice), 'sent') });
  test.provided.set(Contracts.workLog.id, { add: async (entry: { title: string; kind: string }) => void work.push(entry), between: async () => [] });
  test.provided.set(Contracts.bots.id, directory);
  const scheduler = new TimerScheduler({ timeZone: 'Asia/Seoul', log: silentLogger, clock: test.clock });
  const ctx: PluginContext = { ...test.ctx, scheduler };
  await assistantSkill({ loadSystemPrompt: async () => TEMPLATE }).setup(ctx);
  await routinesSkill().setup({ ...ctx, kv: new MapKeyValueStore() });
  scheduler.start();
  const botLines: { bot: { id: string }; text: string }[] = [];
  test.bus.on('bots.message', (event) => void botLines.push(event));
  return { llm, test, ctx, notices, work, directory, botLines, scheduler };
}

describe('routines', () => {
  it('adds a routine from chat, runs it on schedule and posts the result', async () => {
    const s = await setup();
    s.llm.queue.push(
      plan('', [{ name: 'routines.add', args: { title: '아침 메일', instruction: '받은 메일을 정리해 줘', schedule: 'daily 09:00' } }]),
      plan('매일 오전 9시에 메일을 정리할게요.'),
    );
    const replies: string[] = [];
    const handler = s.test.handlers[0]!;
    await handler.handle(
      { id: 'm1', conversation: { channelId: 'c', address: 'a' }, authorId: 'owner', fromOwner: true, text: '매일 아침 9시에 메일 정리해줘', receivedAt: s.test.clock.now() },
      { reply: async (_to, out) => void replies.push(out.text) },
    );
    expect(replies).toEqual(['매일 오전 9시에 메일을 정리할게요.']);
    const listed = await s.ctx.tools.execute('routines.list', {});
    expect(listed).toMatchObject({ status: 'done', output: { routines: [{ title: '아침 메일', schedule: '매일 오전 9시', enabled: true }] } });

    await s.test.clock.advance(HOUR + 1000);
    expect(s.notices).toEqual([expect.objectContaining({ kind: 'routines.result', text: '[루틴] 아침 메일\n메일 3개를 정리했어요.' })]);
    expect(s.work).toEqual([expect.objectContaining({ title: '아침 메일', kind: 'routine' })]);
    const turn = s.llm.requests.at(-1)!;
    expect(turn.messages.at(-1)?.content).toBe('받은 메일을 정리해 줘');
    const after = await s.ctx.tools.execute('routines.list', {});
    expect(after).toMatchObject({ output: { routines: [{ lastResult: '메일 3개를 정리했어요.' }] } });
    await s.scheduler.stop();
  });

  it('runs a bot routine in the bot room and validates input', async () => {
    const s = await setup((req) => plan(req.purpose === 'bot.mail-bot' ? '메일함을 확인했어요.' : '네.'));
    await s.directory.upsert({ id: 'mail-bot', name: '메일 봇', role: '메일 정리', kind: 'general', origin: 'owner' });
    const added = await s.ctx.tools.execute('routines.add', { title: '메일 확인', instruction: '메일함 확인', schedule: { kind: 'every', hours: 2 }, bot: 'mail-bot' }, { grounding: [] });
    expect(added.status).toBe('done');
    expect((await s.ctx.tools.execute('routines.add', { title: 'x', instruction: 'y', schedule: 'daily 25:00' })).status).toBe('invalid_input');
    expect((await s.ctx.tools.execute('routines.add', { title: 'x', instruction: 'y', schedule: 'daily 09:00', bot: 'nobody' })).status).toBe('failed');

    await s.test.clock.advance(2 * HOUR + 1000);
    expect(s.botLines).toEqual([{ bot: { id: 'mail-bot', name: '메일 봇' }, text: '메일함을 확인했어요.' }]);
    expect(s.notices).toEqual([]);
    expect(s.work[0]).toMatchObject({ kind: 'routine', bot: { id: 'mail-bot' } });
    expect((await s.directory.get('mail-bot'))?.status).toBe('idle');
    await s.scheduler.stop();
  });

  it('pauses a routine after three failures in a row and says so once', async () => {
    const s = await setup(() => 'not json');
    await s.ctx.tools.execute('routines.add', { title: '날씨', instruction: '날씨 알려 줘', schedule: { kind: 'every', hours: 1 } });
    for (let i = 0; i < 5; i += 1) await s.test.clock.advance(HOUR);
    const paused = s.notices.filter((n) => n.kind === 'routines.paused');
    expect(paused).toHaveLength(1);
    expect(paused[0]?.text).toContain('"날씨" 루틴이 세 번 연속');
    expect(s.notices.filter((n) => n.kind === 'routines.result')).toHaveLength(0);
    // two plan attempts per run, three runs, then nothing
    expect(s.llm.requests).toHaveLength(6);
    expect(await s.ctx.tools.execute('routines.list', {})).toMatchObject({ output: { routines: [{ enabled: false }] } });
    await s.scheduler.stop();
  });

  it('lets a bot schedule one follow-up and runs it later in its room', async () => {
    const s = await setup((req) => plan(req.purpose === 'bot.dev' ? '빌드가 끝났어요.' : '네.'));
    await s.directory.upsert({ id: 'dev', name: '개발 봇', role: '빌드', kind: 'dev', origin: 'owner' });
    expect((await s.ctx.tools.execute('bots.follow_up', { bot: 'dev', what: '빌드 결과 확인', in_hours: 2 })).status).toBe('done');
    expect((await s.ctx.tools.execute('bots.follow_up', { bot: 'dev', what: '또', in_hours: 1 })).status).toBe('failed');
    await s.test.clock.advance(HOUR);
    expect(s.botLines).toEqual([]);
    await s.test.clock.advance(HOUR + 300_000);
    expect(s.botLines).toEqual([{ bot: { id: 'dev', name: '개발 봇' }, text: '빌드가 끝났어요.' }]);
    expect(s.llm.requests.at(-1)?.messages.at(-1)?.content).toContain('빌드 결과 확인');
    expect((await s.ctx.tools.execute('bots.follow_up', { bot: 'dev', what: '다시', in_hours: 1 })).status).toBe('done');
    await s.scheduler.stop();
  });

  it('labels schedules in plain Korean and checks the weekday', () => {
    const weekly = routineScheduleSchema.parse(scheduleFromText('weekly mon 14:30'));
    expect(scheduleLabel(weekly, true)).toBe('매주 월요일 오후 2시 30분');
    expect(scheduleLabel({ kind: 'daily', at: '00:00' }, true)).toBe('매일 오전 12시');
    expect(scheduleLabel({ kind: 'every', hours: 3 }, true)).toBe('3시간마다');
    expect(dueOn(weekly, new Date('2026-11-16T14:30:00+09:00'), 'Asia/Seoul')).toBe(true);
    expect(dueOn(weekly, new Date('2026-11-17T14:30:00+09:00'), 'Asia/Seoul')).toBe(false);
    expect(routineScheduleSchema.safeParse({ kind: 'every', hours: 0 }).success).toBe(false);
  });

  it('runs a monthly routine on its day, or the last day of a shorter month', () => {
    const last = routineScheduleSchema.parse(scheduleFromText('monthly last 09:00'));
    expect(last).toEqual({ kind: 'monthly', day: -1, at: '09:00' });
    expect(scheduleLabel(last, true)).toBe('매월 말일 오전 9시');
    expect(dueOn(last, new Date('2026-11-30T09:00:00+09:00'), 'Asia/Seoul')).toBe(true);
    expect(dueOn(last, new Date('2026-11-29T09:00:00+09:00'), 'Asia/Seoul')).toBe(false);
    const day31 = { kind: 'monthly' as const, day: 31, at: '09:00' };
    expect(dueOn(day31, new Date('2026-02-28T09:00:00+09:00'), 'Asia/Seoul')).toBe(true);
    expect(dueOn({ kind: 'monthly', day: 5, at: '09:00' }, new Date('2026-12-05T09:00:00+09:00'), 'Asia/Seoul')).toBe(true);
    expect(routineScheduleSchema.safeParse({ kind: 'monthly', day: 0, at: '09:00' }).success).toBe(false);
  });
});

function appModel(): LlmProvider {
  return {
    id: 'fake',
    async complete(_model, request) {
      const last = request.messages.at(-1)?.content ?? '';
      const text = last.includes('tool_results')
        ? plan('루틴을 만들었어요.')
        : last.includes('매일 아침')
          ? plan('', [{ name: 'routines.add', args: { title: '아침 정리', instruction: '오늘 할 일 정리', schedule: { kind: 'daily', at: '09:00' } } }])
          : plan('네.');
      return { text, providerId: 'fake', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  };
}

describe('routines app view', () => {
  it('lists routines with plain labels and toggles and removes them', async () => {
    const h = await startApp({ llm: appModel(), plugins: [assistantSkill({ loadSystemPrompt: async () => TEMPLATE }), routinesSkill()] });
    try {
      const { token } = await pairApp(h);
      const caps = (await (await api(h, token, 'capabilities')).json()) as { features: string[] };
      expect(caps.features).toContain('routines');
      await api(h, token, 'messages', { text: '매일 아침 9시에 할 일 정리해줘' });
      await until(async () => (await events(h, token)).some((e) => e.type === 'message' && e.text === '루틴을 만들었어요.'));
      type View = { data: { routines: { id: string; title: string; scheduleLabel: string; enabled: boolean }[]; limit: number } };
      const view = (await (await api(h, token, 'views/routines')).json()) as View;
      expect(view.data.limit).toBe(30);
      const routine = view.data.routines[0]!;
      expect(routine).toMatchObject({ title: '아침 정리', scheduleLabel: '매일 오전 9시', enabled: true });

      expect((await api(h, token, 'views/routines/toggle', { id: routine.id, enabled: false })).status).toBe(200);
      const off = (await (await api(h, token, 'views/routines')).json()) as View;
      expect(off.data.routines[0]?.enabled).toBe(false);
      expect((await api(h, token, 'views/routines/toggle', { id: 'nope', enabled: true })).status).toBe(400);
      expect((await api(h, token, 'views/routines/toggle', { id: routine.id })).status).toBe(400);

      expect((await api(h, token, 'views/routines/remove', { id: routine.id })).status).toBe(200);
      const gone = (await (await api(h, token, 'views/routines')).json()) as View;
      expect(gone.data.routines).toEqual([]);
      // off the jobs screen at once, not at the next restart
      const jobs = JSON.stringify(await (await api(h, token, 'views/jobs')).json());
      expect(jobs).not.toContain(`routine.${routine.id}`);
      expect((await api(h, token, 'views/routines/toggle', { id: routine.id, enabled: true })).status).toBe(400);
    } finally {
      await h.stop();
    }
  });
});
