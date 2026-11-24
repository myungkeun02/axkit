import type { PluginContext } from '../../core/plugin/types.js';
import type { ExpenseDeps } from './deps.js';
import { registerClaimTools } from './tools-claims.js';
import { registerRuleTools } from './tools-rules.js';

/** Registers every expenses.* tool. */
export function registerExpenseTools(ctx: PluginContext, deps: ExpenseDeps): void {
  registerRuleTools(ctx, deps);
  registerClaimTools(ctx, deps);
}
