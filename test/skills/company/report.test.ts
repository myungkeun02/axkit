import { describe, expect, it } from 'vitest';
import type { Notice, NoticeResult } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { buildReport, registerReport } from '../../../src/skills/company/report.js';
import { reportTexts } from '../../../src/skills/company/locale-intake.js';
import {
  companyConfig,
  DEV,
  FakeNotifier,
  MARKETING,
  NOW,
  setupIntake,
  task,
} from './helpers.js';

const TEXTS = reportTexts('ko');
const TEAMS = [DEV, MARKETING];
const TODAY = new Date('2026-11-18T08:00:00+09:00');
const YESTERDAY = new Date('2026-11-17T08:00:00+09:00');

function report(tasks: ReturnType<typeof task>[]) {
  return buildReport({ tasks, teams: TEAMS, now: NOW, timeZone: 'Asia/Seoul', texts: TEXTS });
}

describe('buildReport', () => {
  it('returns undefined when nothing is open and nothing finished today', () => {
    expect(report([])).toBeUndefined();
    expect(
      report([task({ id: 'aaaaaaaa', status: 'done', finishedAt: YESTERDAY.toISOString() })]),
    ).toBeUndefined();
  });

  it('groups open and finished work per team with counts, closed reasons and choices', () => {
    const tasks = [
      task({ id: 'aaaaaaaa', team: 'dev', title: '로그인 고치기', status: 'queued' }),
      task({ id: 'bbbbbbbb', team: 'marketing', title: '메일에서 온 일', status: 'awaiting_accept' }),
      task({ id: 'cccccccc', team: 'dev', title: '배포 완료', status: 'done', finishedAt: TODAY.toISOString() }),
      task({
        id: 'dddddddd',
        team: 'marketing',
        title: '광고 정리',
        status: 'closed',
        closedReason: 'stale',
        finishedAt: TODAY.toISOString(),
      }),
    ];

    const result = report(tasks);

    if (result === undefined) throw new Error('no report');
    expect(result.text.split('\n')).toEqual([
      '회사 일 2026-11-18 — 완료 1 · 실패 0 · 닫힘 1 · 열림 2',
      '**개발**',
      '• 대기 로그인 고치기',
      '• 완료 배포 완료',
      '**마케팅**',
      '• 대기 확인 메일에서 온 일',
      '• 닫힘 (오래 멈춤) 광고 정리',
    ]);
    expect(result.choices).toEqual([
      { id: 'company.accept:bbbbbbbb', label: '받기 메일에서 온 일' },
      { id: 'company.drop:bbbbbbbb', label: '거절 메일에서 온 일' },
    ]);
  });

  it('shows at most six task lines per team and folds the rest into … +K', () => {
    const tasks = Array.from({ length: 8 }, (_, index) =>
      task({ id: index.toString(16).padStart(8, '0'), team: 'dev', title: `일 ${index}`, status: 'running' }),
    );

    const result = report(tasks);

    if (result === undefined) throw new Error('no report');
    const lines = result.text.split('\n');
    expect(lines.filter((line) => line.startsWith('• '))).toHaveLength(6);
    expect(lines).toContain('… +2');
  });

  it('offers accept and drop for at most five awaiting tasks and clips long titles', () => {
    const longTitle = '아주 긴 제목이 계속 이어지는 메일에서 온 일입니다';
    const tasks = Array.from({ length: 6 }, (_, index) =>
      task({
        id: index.toString(16).padStart(8, '0'),
        team: 'dev',
        title: index === 0 ? longTitle : `대기 ${index}`,
        status: 'awaiting_accept',
      }),
    );

    const result = report(tasks);

    if (result === undefined) throw new Error('no report');
    expect(result.choices).toHaveLength(10);
    expect(result.choices.some((choice) => choice.id === 'company.accept:00000005')).toBe(false);
    expect(result.choices[0]?.label).toMatch(/…$/);
    expect(result.choices[0]?.label.length).toBeLessThanOrEqual(23);
  });
});

class OrderNotifier extends FakeNotifier {
  constructor(private readonly events: string[]) {
    super();
  }
  override async notify(notice: Notice): Promise<NoticeResult> {
    this.events.push('notify');
    return super.notify(notice);
  }
}

describe('registerReport', () => {
  it('reaps first, then sends exactly one daily notice', async () => {
    const events: string[] = [];
    const notifier = new OrderNotifier(events);
    const setup = setupIntake({ capabilities: { [Contracts.notifier.id]: notifier } });
    await setup.repo.create({ team: 'dev', title: '로그인', request: '로그인', source: 'owner', status: 'queued' });
    registerReport(setup.ctx, setup.repo, companyConfig(), TEXTS, async () => {
      events.push('reap');
      return [];
    });

    await setup.scheduler.run('company.report', NOW);

    expect(events).toEqual(['reap', 'notify']);
    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]).toMatchObject({
      kind: 'company.report',
      dedupeKey: '2026-11-18',
      text: '회사 일 2026-11-18 — 완료 0 · 실패 0 · 닫힘 0 · 열림 1\n**개발**\n• 대기 로그인',
    });
    expect(notifier.notices[0]?.choices).toEqual([]);
  });

  it('sends choices for awaiting tasks and skips the notice when nothing happened', async () => {
    const notifier = new FakeNotifier();
    const setup = setupIntake({ capabilities: { [Contracts.notifier.id]: notifier } });
    registerReport(setup.ctx, setup.repo, companyConfig(), TEXTS, async () => []);
    await setup.scheduler.run('company.report', NOW);
    expect(notifier.notices).toHaveLength(0);

    await setup.repo.create({
      team: 'dev',
      title: '메일에서 온 일',
      request: '메일에서 온 일',
      source: 'mail',
      status: 'awaiting_accept',
    });
    await setup.scheduler.run('company.report', NOW);

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.choices).toHaveLength(2);
  });
});
