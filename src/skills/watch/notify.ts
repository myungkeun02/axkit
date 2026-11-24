import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';

export interface WatchNotice {
  kind: 'watch.alert' | 'watch.failing';
  text: string;
  dedupeKey: string;
}

/** Proactive messages only through the notifier; a missing notifier never fails a check. */
export async function sendWatchNotice(ctx: PluginContext, notice: WatchNotice): Promise<boolean> {
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    ctx.log.warn('watch: notice skipped without a notifier', { kind: notice.kind });
    return false;
  }
  try {
    await notifier.notify(notice);
    return true;
  } catch (error) {
    ctx.log.warn('watch: notice failed', {
      kind: notice.kind,
      error: error instanceof Error ? error.name : 'error',
    });
    return false;
  }
}
