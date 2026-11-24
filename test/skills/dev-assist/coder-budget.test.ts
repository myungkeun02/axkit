import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { CODER_RUNS_PER_DAY, coderGate } from '../../../src/skills/dev-assist/coder-budget.js';
import { createTestContext } from '../../support/context.js';

describe('coding runs count against the stop switch, the AI budget and a daily cap', () => {
  it('stops when everything is stopped or the budget is used up, and after the day’s runs', async () => {
    const stopped = createTestContext({ capabilities: { [Contracts.killSwitch.id]: { state: async () => ({ stopped: true, reason: '주인이 멈춤' }) } } });
    expect(await coderGate(stopped.ctx)).toContain('전체 멈춤');
    const broke = createTestContext({ capabilities: { [Contracts.llmControl.id]: { overBudget: async () => true } } });
    expect(await coderGate(broke.ctx)).toContain('예산');
    const fine = createTestContext({});
    for (let i = 0; i < CODER_RUNS_PER_DAY; i += 1) expect(await coderGate(fine.ctx)).toBeUndefined();
    expect(await coderGate(fine.ctx)).toContain('내일');
  });
});
