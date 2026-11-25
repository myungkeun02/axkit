import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { FirstLookProgress } from '../../../src/core/contracts/first-look.js';
import { FirstLookFlow } from '../../../src/skills/assistant/first-look.js';
import { createTestContext } from '../../support/context.js';

function setup(progress: Partial<FirstLookProgress>, google: boolean) {
  const starts: number[] = [];
  const notices: string[] = [];
  const reader = { progress: () => ({ status: 'idle', phase: '', phases: [], counts: {}, percent: 0, startedAt: null, ...progress }) as FirstLookProgress, start: () => (starts.push(1), 'started' as const) };
  const { ctx } = createTestContext({
    capabilities: {
      [Contracts.firstLook.id]: reader,
      [Contracts.notifier.id]: { notify: async (n: { text: string }) => void notices.push(n.text) },
      ...(google ? { [Contracts.mailRead.id]: {} } : {}),
    },
  });
  return { flow: new FirstLookFlow({ ctx, korean: true, plans: {} as never }), starts, notices };
}

describe('the first look starts on its own', () => {
  it('runs once after setup', async () => {
    const { flow, starts, notices } = setup({}, false);
    await flow.autoStart();
    expect(starts).toHaveLength(1);
    expect(notices[0]).toContain('처음 알아보기를 시작했어요');
  });

  it('runs again once when Google was connected after a look without Drive', async () => {
    const { flow, starts, notices } = setup({ status: 'done', startedAt: '2026-11-20T00:00:00Z', counts: { drive: 0 } }, true);
    await flow.autoStart();
    await flow.autoStart();
    expect(starts).toHaveLength(1);
    expect(notices[0]).toContain('구글이 연결돼서');
  });

  it('leaves a finished look with Drive alone', async () => {
    const { flow, starts } = setup({ status: 'done', startedAt: '2026-11-20T00:00:00Z', counts: { drive: 40 } }, true);
    await flow.autoStart();
    expect(starts).toHaveLength(0);
  });
});
