import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Contracts } from '../../../src/core/contracts/index.js';
import { Initiative, initiativeTask } from '../../../src/skills/assistant/initiative.js';
import { createTestContext } from '../../support/context.js';

function setup(replies: Record<string, string>) {
  const tasks: { bot: string; task: string }[] = [];
  const notices: string[] = [];
  const teams = [
    { id: 'team-qa', name: 'QA', purpose: '서비스를 테스트해요', lead: 'qa', kind: 'general' },
    { id: 'team-pm', name: 'PM', purpose: '다음 개발 작업을 정해요', lead: 'pm', kind: 'general' },
    { id: 'team-ax-dev', name: 'ax', lead: 'ax-dev', kind: 'dev' },
  ];
  const bots = [{ id: 'qa', status: 'idle' }, { id: 'pm', status: 'idle' }, { id: 'ax-dev', status: 'idle' }];
  const context = createTestContext({
    capabilities: {
      [Contracts.bots.id]: { teams: async () => teams, list: async () => bots },
      [Contracts.notifier.id]: { notify: async (notice: { text: string }) => (notices.push(notice.text), { delivered: true }) },
    },
  });
  context.ctx.registerTool({
    name: 'bots.delegate',
    description: '',
    input: z.object({ bot: z.string(), task: z.string() }),
    effects: ['write'],
    run: async (value: { bot: string; task: string }) => (tasks.push(value), { bot: value.bot, summary: replies[value.bot] ?? '오늘은 할 일 없음' }),
  } as never);
  return { initiative: new Initiative(context.ctx, true), tasks, notices };
}

describe('teams that find their own work', () => {
  it('once a day at its time, each team lead looks for one thing; only real work is told', async () => {
    const { initiative, tasks, notices } = setup({ qa: '업무보드 로그에서 500 오류 3건을 찾아 정리했어요.' });
    expect(await initiative.tick(new Date('2026-11-25T09:00:00+09:00'))).toBe(0);
    expect(await initiative.tick(new Date('2026-11-25T10:05:00+09:00'))).toBe(2);
    expect(tasks.map((task) => task.bot).sort()).toEqual(['pm', 'qa']);
    expect(tasks[0]?.task).toContain('누가 시키지 않았어요');
    expect(notices).toEqual(["오늘 팀들이 스스로 찾아서 한 일이 1건 있어요(QA). 자세한 내용은 캘린더의 '한 일'에서 볼 수 있어요."]);
    // not again the same day; again the next day
    expect(await initiative.tick(new Date('2026-11-25T15:00:00+09:00'))).toBe(0);
    expect(await initiative.tick(new Date('2026-11-26T10:00:00+09:00'))).toBe(2);
  });

  it('can be turned off', async () => {
    const { initiative, tasks } = setup({});
    await initiative.set(false);
    expect(await initiative.tick(new Date('2026-11-25T11:00:00+09:00'))).toBe(0);
    expect(tasks).toHaveLength(0);
    expect(initiativeTask({ id: 't', name: 'QA', purpose: '테스트', lead: 'qa' } as never, true)).toContain('오늘은 할 일 없음');
  });
});
