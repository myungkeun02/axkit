import type { Fact } from '../../core/contracts/memory.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';

/** Memory is optional: the assistant answers the same when no memory skill is loaded. */
export async function recalledFacts(ctx: PluginContext, text: string): Promise<readonly Fact[]> {
  const memory = ctx.tryUse(Contracts.memoryRead);
  if (memory === undefined) return [];
  try {
    return await memory.recall({ text, limit: 8 });
  } catch (error) {
    ctx.log.warn('assistant: memory recall failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

const PROFILE_CHARS = 600;

export async function profileSummary(ctx: PluginContext): Promise<string | undefined> {
  const profile = ctx.tryUse(Contracts.knowledgeProfile);
  if (profile === undefined) return undefined;
  try {
    return await profile.summary(PROFILE_CHARS);
  } catch (error) {
    ctx.log.warn('assistant: profile summary failed', { error: error instanceof Error ? error.name : 'unknown' });
    return undefined;
  }
}
