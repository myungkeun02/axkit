import { describe, expect, it } from 'vitest';
import { dailyPoints, usageView } from '../../../src/channels/app/builtin-views.js';
import { AppEventLog } from '../../../src/channels/app/log.js';
import { todayView } from '../../../src/channels/app/today-view.js';
import { jobsView, scheduleLabel } from '../../../src/channels/app/views/jobs.js';
import { acceptedFor, actualOf, modelsView } from '../../../src/channels/app/views/models.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { LlmRoute, LlmRoutingInfo } from '../../../src/core/llm/types.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { TimerScheduler } from '../../../src/core/scheduler/scheduler.js';
import { createTestContext } from '../../support/context.js';
import { MapKeyValueStore } from '../../core/helpers.js';

const NOW = new Date('2026-11-18T09:00:00+09:00');
const q = new URLSearchParams();

describe('jobs view', () => {
  it('lists every scheduler job with a readable name, schedule, last run and paused jobs apart', async () => {
    const { ctx, clock } = createTestContext({
      now: NOW,
      capabilities: {
        [Contracts.switches.id]: {
          list: async () => [
            { feature: 'skill.spending', reason: '카드 문자 오류', until: '2026-11-20T00:00:00.000Z', byKind: 'owner', by: 'o', createdAt: '', auto: false },
          ],
        },
      },
    });
    const scheduler = new TimerScheduler({ timeZone: 'Asia/Seoul', log: silentLogger, clock });
    scheduler.add({ name: 'briefing.morning', schedule: { kind: 'daily', at: '07:30' }, run: async () => undefined });
    scheduler.add({ name: 'spending.mail', schedule: { kind: 'every', seconds: 900 }, run: async () => undefined });
    scheduler.add({ name: 'custom.thing', label: '내 작업', schedule: { kind: 'every', seconds: 7200 }, run: async () => {
      throw new Error('boom');
    } });
    scheduler.start();
    await clock.advance(7_200_000);

    const data = (await jobsView({ ...ctx, scheduler }).read(q)) as {
      groups: { id: string; jobs: Record<string, unknown>[] }[];
    };
    const [on, off] = data.groups;
    expect(on?.id).toBe('ax');
    expect(on?.jobs.map((job) => job['name'])).toEqual(['내 작업', '아침 브리핑']);
    expect(on?.jobs[0]).toMatchObject({
      id: 'custom.thing',
      scheduleLabel: '2시간마다',
      schedule: { kind: 'interval', everySec: 7200 },
      enabled: true,
      running: false,
      lastRun: { ok: false, error: 'boom' },
      source: 'ax',
    });
    expect(on?.jobs[1]).toMatchObject({ scheduleLabel: '매일 07:30', schedule: { kind: 'daily', at: '07:30', timezone: 'Asia/Seoul' }, lastRun: null });
    expect(typeof on?.jobs[1]?.['nextRunAt']).toBe('string');
    expect(off?.id).toBe('off');
    expect(off?.jobs[0]).toMatchObject({ id: 'spending.mail', name: '메일 영수증 읽기', enabled: false, nextRunAt: null });
    expect(String(off?.jobs[0]?.['detail'])).toContain('카드 문자 오류');
    await scheduler.stop();
  });

  it('labels intervals in both languages', () => {
    expect(scheduleLabel({ kind: 'every', seconds: 300 }, 'ko')).toBe('5분마다');
    expect(scheduleLabel({ kind: 'every', seconds: 45 }, 'en')).toBe('every 45 s');
    expect(scheduleLabel({ kind: 'every', seconds: 86_400 }, 'ko')).toBe('1일마다');
  });
});

const ROUTES: LlmRoute[] = [
  { providerId: 'claude-cli', model: 'opus', tiers: ['deep'], maxSensitivity: 'sensitive' },
  { providerId: 'claude-cli', model: 'sonnet', tiers: ['standard'], maxSensitivity: 'sensitive' },
  { providerId: 'deepseek', model: 'chat', tiers: ['fast', 'standard'], maxSensitivity: 'masked' },
  { providerId: 'ollama', model: 'small', tiers: ['fast'], maxSensitivity: 'sensitive' },
];

describe('models view', () => {
  it('treats a stronger tier and a suffixed model id as configured', () => {
    expect(acceptedFor(ROUTES, 'fast', { vendor: 'claude-cli', model: 'opus' })).toBe(true);
    expect(acceptedFor(ROUTES, 'fast', { vendor: 'ollama', model: 'small-q4' })).toBe(true);
    expect(acceptedFor(ROUTES, 'deep', { vendor: 'deepseek', model: 'chat' })).toBe(false);
    expect(acceptedFor(ROUTES, 'standard', { vendor: 'other', model: 'sonnet' })).toBe(false);
  });

  it('groups the last calls by tier and purpose and flags a purpose run outside its tier', () => {
    const actual = actualOf(ROUTES, [
      { purpose: 'assistant.plan', providerId: 'deepseek', model: 'chat', tier: 'deep', calls: 5, failures: 0, costUsd: 0.1 },
      { purpose: 'assistant.plan', providerId: 'claude-cli', model: 'opus', tier: 'deep', calls: 1, failures: 2, costUsd: 0 },
      { purpose: 'briefing.morning', providerId: 'ollama', model: 'small', tier: 'fast', calls: 3, failures: 0, costUsd: 0 },
      { purpose: 'legacy', providerId: 'ollama', model: 'small', tier: null, calls: 2, failures: 0, costUsd: 0 },
    ]);
    expect(actual.byTier.map((row) => row.tier)).toEqual(['deep', 'fast']);
    expect(actual.byPurpose[0]).toMatchObject({ prefix: 'assistant.plan', tier: 'deep', mismatch: true });
    expect(actual.byPurpose[0]?.models[0]).toMatchObject({ vendor: 'deepseek', model: 'chat', calls: 5 });
    expect(actual.byPurpose.find((row) => row.prefix === 'briefing.morning')?.mismatch).toBe(false);
    expect(actual.byPurpose.find((row) => row.prefix === 'legacy')).toMatchObject({ tier: '', mismatch: false });
  });

  it('shows tiers with candidates in order, active providers and breaker state', async () => {
    const { ctx } = createTestContext({
      now: NOW,
      capabilities: {
        [Contracts.usage.id]: {
          byPurpose: async () => [],
          byPurposeModel: async () => [
            { purpose: 'assistant.turn', providerId: 'claude-cli', model: 'sonnet', tier: 'standard', calls: 2, failures: 0, costUsd: 0 },
          ],
        },
      },
    });
    const info: LlmRoutingInfo = {
      routes: ROUTES,
      activeProviders: ['claude-cli', 'deepseek'],
      circuits: [
        { providerId: 'claude-cli', state: 'closed', failures: 0 },
        { providerId: 'deepseek', state: 'open', failures: 3, retryAt: new Date('2026-11-18T00:05:00Z') },
      ],
    };
    const data = (await modelsView(ctx, () => info).read(q)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(data['tiers'].map((tier: { id: string }) => tier.id)).toEqual(['deep', 'standard', 'fast', 'cheap']);
    expect(data['tiers'][2].candidates).toEqual([
      { vendor: 'deepseek', model: 'chat', note: '가린 개인정보까지' },
      { vendor: 'ollama', model: 'small', note: '공급자 꺼짐' },
    ]);
    expect(data['purposes']).toEqual([{ prefix: 'assistant.turn', tier: 'standard', label: 'assistant.turn' }]);
    expect(data['circuits'][1]).toEqual({ vendor: 'deepseek', state: 'open', until: '2026-11-18T00:05:00.000Z', reason: '연속 실패 3번' });
    expect(data['actual'].since).toBe('2026-11-11T15:00:00.000Z');
  });
});

describe('today view', () => {
  it('fills events with end and source, replies from chats and mail, and today’s spending', async () => {
    const { ctx } = createTestContext({
      now: NOW,
      capabilities: {
        [Contracts.calendarRead.id]: {
          listEvents: async () => [
            { id: '1', title: '지난 회의', start: '2026-11-18T07:00:00+09:00', end: '2026-11-18T08:00:00+09:00', allDay: false },
            { id: '2', title: '점심', start: '2026-11-18T12:00:00+09:00', end: '2026-11-18T13:00:00+09:00', allDay: false },
          ],
        },
        [Contracts.todoRead.id]: { open: async () => [{ id: 't', text: '보고서', due: '2026-11-18' }] },
        [Contracts.chatAwaiting.id]: {
          awaiting: async () => [{ app: 'kakao', room: '민수', text: '내일   시간 돼?', at: '2026-11-18T08:00:00+09:00', unread: 2 }],
        },
        [Contracts.mailAwaiting.id]: {
          awaitingReply: async () => [
            { id: 'm', threadId: 'm', from: '"Kim" <kim@example.com>', subject: '견적 문의', snippet: '', receivedAt: new Date('2026-11-17T10:00:00Z'), unread: false, important: true },
          ],
        },
        [Contracts.spendRead.id]: {
          entries: async () => [{ amount: 4500 }, { amount: 12000 }],
          homeCurrency: () => 'KRW',
        },
      },
    });
    const log = new AppEventLog(new MapKeyValueStore(), ctx.clock);
    const data = (await todayView(ctx, log).read(q)) as Record<string, unknown>;
    expect(data['events']).toEqual([
      { id: '2', title: '점심', start: '2026-11-18T12:00:00+09:00', end: '2026-11-18T13:00:00+09:00', allDay: false, source: 'calendar' },
    ]);
    expect(data['todos']).toEqual([{ text: '보고서', due: '2026-11-18', source: 'todo' }]);
    expect(data['replies']).toEqual([
      { from: '민수', text: '내일 시간 돼?', source: '카톡', at: '2026-11-18T08:00:00+09:00' },
      { from: 'Kim', text: '견적 문의', source: '메일', at: '2026-11-17T10:00:00.000Z' },
    ]);
    expect(data['spend']).toEqual({ amount: 16500, count: 2 });
    expect(data['pendingCards']).toBe(0);
  });

  it('reports parts that are not connected as null and leaves spend out', async () => {
    const { ctx } = createTestContext({ now: NOW });
    const data = (await todayView(ctx, new AppEventLog(new MapKeyValueStore(), ctx.clock)).read(q)) as Record<string, unknown>;
    expect(data).toEqual({ date: '2026-11-18', events: null, todos: null, pendingCards: 0, replies: null });
  });
});

describe('usage daily series', () => {
  it('regroups UTC buckets into local hours with every slot present', () => {
    const since = new Date('2026-11-17T15:00:00Z'); // 00:00 in Seoul
    const now = new Date('2026-11-18T02:30:00Z'); // 11:30 in Seoul
    const points = dailyPoints(
      [
        { startMs: Date.parse('2026-11-17T15:15:00Z'), calls: 1, failures: 0, costUsd: 0.01 },
        { startMs: Date.parse('2026-11-17T15:45:00Z'), calls: 2, failures: 1, costUsd: 0.02 },
        { startMs: Date.parse('2026-11-18T02:00:00Z'), calls: 1, failures: 0, costUsd: 0 },
      ],
      since,
      now,
      'Asia/Seoul',
      true,
    );
    expect(points).toHaveLength(12);
    expect(points[0]).toEqual({ date: '2026-11-18T00:00', calls: 3, failures: 1, costUsd: 0.03 });
    expect(points[11]).toEqual({ date: '2026-11-18T11:00', calls: 1, failures: 0, costUsd: 0 });
  });

  it('adds daily points to the usage view for a week', async () => {
    const { ctx } = createTestContext({
      now: NOW,
      capabilities: {
        [Contracts.usage.id]: {
          byPurpose: async () => [],
          timeline: async () => [{ startMs: Date.parse('2026-11-16T03:00:00Z'), calls: 4, failures: 0, costUsd: 0.5 }],
        },
      },
    });
    const data = (await usageView(ctx, undefined).read(new URLSearchParams('period=week'))) as { daily: { date: string; calls: number }[] };
    expect(data.daily.map((point) => point.date)).toEqual([
      '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18',
    ]);
    expect(data.daily[4]).toMatchObject({ calls: 4 });
  });
});

describe('share texts', () => {
  it('say which app the owner shared from', async () => {
    const { appTexts } = await import('../../../src/channels/app/locale.js');
    expect(appTexts('ko').sharedText('링크', 'desktop')).toBe('(데스크톱에서 공유)\n링크');
    expect(appTexts('ko').sharedFile('a.png', 'image')).toBe('(휴대폰에서 사진을 공유했어요: a.png)');
    expect(appTexts('en').sharedText('x', 'desktop')).toBe('(Shared from the desktop)\nx');
  });
});
