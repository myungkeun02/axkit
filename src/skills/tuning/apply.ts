import { Contracts } from '../../core/contracts/index.js';
import type { TuningChange } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';

const DAY_MS = 86_400_000;
const PAUSE_DAYS = 7;
const PAUSE_REASON = 'self-tuning: repeated failures';

async function applyNotice(ctx: PluginContext, change: TuningChange): Promise<void> {
  const muter = ctx.tryUse(Contracts.noticeMute);
  if (muter === undefined) {
    ctx.log.warn('tuning: notice mute capability missing', { subject: change.subject });
    return;
  }
  if (change.action === 'unmute') await muter.unmute(change.subject);
  else await muter.mute(change.subject);
}

async function applyFeature(ctx: PluginContext, change: TuningChange, now: Date): Promise<void> {
  const switches = ctx.tryUse(Contracts.switches);
  if (switches === undefined) {
    ctx.log.warn('tuning: feature switches capability missing', { feature: change.subject });
    return;
  }
  if (change.action === 'unmute') {
    await switches.resume(change.subject);
    return;
  }
  if (change.action !== 'mute') return;
  await switches.pause(change.subject, {
    reason: PAUSE_REASON,
    until: new Date(now.getTime() + PAUSE_DAYS * DAY_MS),
    // The owner pressed the button, so the pause is theirs even though a rule suggested it.
    by: { kind: 'user', id: 'owner' },
  });
}

/** Applies one approved change and tells the domain owner; nothing here runs without a button press. */
export async function applyChange(ctx: PluginContext, change: TuningChange, now: Date): Promise<void> {
  if (change.domain === 'notice') await applyNotice(ctx, change);
  else if (change.domain === 'feature') await applyFeature(ctx, change, now);
  await ctx.bus.emit('tuning.apply', change);
}
