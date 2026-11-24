import { describe, expect, it } from 'vitest';
import { setup } from '../browser/helpers.js';

describe('background task result and the turn that started it', () => {
  it('reports only after the starting turn has given its own answer', async () => {
    const context = await setup();
    const after: (() => Promise<void>)[] = [];
    const outcome = await context.ctx.tools.execute('browser.task', { goal: '가격 알아보기', startUrl: 'https://example.com/' }, { grounding: [], afterTurn: (work) => void after.push(work) });
    expect(outcome.status).toBe('done');
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve));
    // the run is over, but the turn has not answered yet: no notice
    expect(context.notifier.notices).toHaveLength(0);
    for (const work of after) await work();
    await context.settled.next();
    expect(context.notifier.notices).toHaveLength(1);
  });
});
