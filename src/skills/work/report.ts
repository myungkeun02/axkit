import type { NoticeResult, WorkItem } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { LiveHandoff } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';

/** Shows the item in the owner's work list when that list is on. Never fails the task. */
export async function mirrorWork(ctx: PluginContext, item: WorkItem): Promise<void> {
  const board = ctx.tryUse(Contracts.workInProgress);
  if (board === undefined) return;
  try {
    await board.upsert(item);
  } catch (error) {
    ctx.log.warn('work: could not update the work list', { id: item.id, error: String(error) });
  }
}

export interface TaskNotice {
  kind: string;
  text: string;
  dedupeKey: string;
  live?: LiveHandoff;
}

/**
 * The result of a task the owner asked for, through the notifier. It counts as urgent: the owner is waiting for it,
 * so quiet hours do not hold it until morning.
 */
export async function notifyOwner(ctx: PluginContext, notice: TaskNotice): Promise<NoticeResult | undefined> {
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) return undefined;
  try {
    return await notifier.notify({
      kind: notice.kind,
      text: notice.text,
      urgent: true,
      dedupeKey: notice.dedupeKey,
      ...(notice.live !== undefined ? { live: notice.live } : {}),
    });
  } catch (error) {
    ctx.log.warn('work: could not tell the owner', { kind: notice.kind, error: String(error) });
    return undefined;
  }
}
