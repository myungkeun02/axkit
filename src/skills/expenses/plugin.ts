import type { Plugin } from '../../core/plugin/types.js';
import { readExpensesConfig } from './config.js';
import { DecisionStore } from './decisions.js';
import { ReportCache } from './deps.js';
import type { ExpenseDeps } from './deps.js';
import { expensesTexts } from './locale.js';
import { registerMonthly } from './monthly.js';
import { KvRuleStore } from './rules.js';
import { registerExpenseTools } from './tools.js';

/**
 * Expense claims: owner-defined rules turn spend entries into claim candidates, learns per merchant, drafts the
 * monthly claim mail and sends it only through mail.send_draft with approval.
 */
export function expensesSkill(): Plugin {
  return {
    manifest: {
      id: 'skill.expenses',
      kind: 'skill',
      title: 'Expense claims',
    },
    setup(ctx) {
      const config = readExpensesConfig(ctx);
      const deps: ExpenseDeps = {
        config,
        texts: expensesTexts(ctx.assistant.language),
        rules: new KvRuleStore(ctx.kv, config.rules),
        decisions: new DecisionStore(ctx.kv),
        cache: new ReportCache(),
      };
      registerExpenseTools(ctx, deps);
      registerMonthly(ctx, deps);
    },
  };
}
