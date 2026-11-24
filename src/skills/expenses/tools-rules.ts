import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';
import { ruleFields, ruleSchema } from './config.js';
import type { ExpenseDeps } from './deps.js';

const removeInput = z.object({
  id: z.string().min(1).max(41).describe('Rule id from expenses.list_rules.'),
});

/** Registers the rule tools: config rules are read-only, owner rules live in kv. */
export function registerRuleTools(ctx: PluginContext, deps: ExpenseDeps): void {
  ctx.registerTool({
    name: 'expenses.list_rules',
    description:
      'List claim rules. Config rules are read-only; rules added with expenses.add_rule can be removed.',
    input: z.object({}),
    effects: ['read'],
    async run() {
      const all = await deps.rules.all();
      return { rules: all.map(({ rule, source }) => ({ ...rule, source })) };
    },
  });

  ctx.registerTool({
    name: 'expenses.add_rule',
    description:
      'Add a claim rule that turns matching spend entries into claim candidates. The owner can remove it later.',
    input: ruleFields,
    effects: ['write'],
    describe: (input) => deps.texts.describeAddRule(input),
    async run(input) {
      const checked = ruleSchema.safeParse(input);
      if (!checked.success) throw new Error(deps.texts.invalidRule);
      const result = await deps.rules.add(checked.data);
      if (result === 'duplicate') throw new Error(deps.texts.ruleExists);
      if (result === 'full') throw new Error(deps.texts.ruleLimit);
      return { rule: checked.data, source: 'owner' as const };
    },
  });

  ctx.registerTool({
    name: 'expenses.remove_rule',
    description: 'Remove a rule the owner added. Rules from the config file can only be removed there.',
    input: removeInput,
    effects: ['delete'],
    describe: (input) => deps.texts.describeRemoveRule(input.id),
    async run(input) {
      const result = await deps.rules.remove(input.id);
      if (result === 'config') throw new Error(deps.texts.ruleFromConfig);
      if (result === 'missing') throw new Error(deps.texts.ruleMissing);
      return { removed: input.id };
    },
  });
}
