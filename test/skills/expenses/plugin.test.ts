import { describe, expect, it } from 'vitest';
import { expensesSkill } from '../../../src/skills/expenses/plugin.js';
import { createTestContext } from '../../support/context.js';
import type { TestContextOptions } from '../../support/context.js';
import { NOW } from './helpers.js';

async function setup(options: TestContextOptions = {}) {
  const context = createTestContext({ now: NOW, ...options });
  await expensesSkill().setup(context.ctx);
  return context;
}

describe('expensesSkill', () => {
  it('declares the plugin manifest', async () => {
    const plugin = expensesSkill();
    expect(plugin.manifest).toEqual({ id: 'skill.expenses', kind: 'skill', title: 'Expense claims' });
  });

  it('registers every tool, the monthly job and the button handler', async () => {
    const { registry, scheduler, handlers } = await setup();

    expect(registry.list().map((tool) => tool.name).sort()).toEqual([
      'expenses.add_rule',
      'expenses.candidates',
      'expenses.draft_claim_mail',
      'expenses.list_rules',
      'expenses.mark',
      'expenses.remove_rule',
      'expenses.summary',
    ]);
    expect(scheduler.jobs.get('expenses.monthly')?.schedule).toEqual({ kind: 'daily', at: '09:00' });
    expect(handlers.map((handler) => [handler.id, handler.priority])).toEqual([['expenses.choices', 75]]);
  });

  it('reads the configured summary time', async () => {
    const { scheduler } = await setup({ config: { summaryAt: '18:30', summaryDay: 25 } });
    expect(scheduler.jobs.get('expenses.monthly')?.schedule).toEqual({ kind: 'daily', at: '18:30' });
  });

  it('falls back to defaults on invalid config and keeps running', async () => {
    const { scheduler, handlers } = await setup({ config: { summaryAt: '25:00', summaryDay: 40 } });
    expect(scheduler.jobs.get('expenses.monthly')?.schedule).toEqual({ kind: 'daily', at: '09:00' });
    expect(handlers).toHaveLength(1);
  });
});
