import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { TodoTexts } from './locale.js';
import type { TodoRepo } from './store.js';

export const REMINDER_JOB = 'todo.reminders';
const CHECK_INTERVAL_SECONDS = 30;
/** An outside list (Google Tasks) is fetched again at most every five minutes by the sweep. */
const SYNC_MAX_AGE_MS = 5 * 60_000;

function isDue(item: { done: boolean; remindAt?: string; reminded?: boolean }, now: Date): boolean {
  if (item.done || item.reminded === true || item.remindAt === undefined) return false;
  return new Date(item.remindAt).getTime() <= now.getTime();
}

/** Registers the 30-second reminder sweep. The notifier is resolved at run time because it may start later. */
export function registerTodoReminders(ctx: PluginContext, store: TodoRepo, texts: TodoTexts): void {
  ctx.scheduler.add({
    name: REMINDER_JOB,
    schedule: { kind: 'every', seconds: CHECK_INTERVAL_SECONDS },
    async run(now) {
      try {
        await store.sync(SYNC_MAX_AGE_MS);
      } catch (error) {
        ctx.log.warn('todo reminders: could not refresh the to-do list', { error: String(error) });
      }
      const due = store.all().filter((item) => isDue(item, now));
      if (due.length === 0) return;
      const notifier = ctx.tryUse(Contracts.notifier);
      if (notifier === undefined) {
        ctx.log.warn('todo reminders: no notifier is available; will retry on the next sweep', {
          count: due.length,
        });
        return;
      }
      for (const item of due) {
        await notifier.notify({
          kind: 'todo.reminder',
          urgent: true,
          dedupeKey: item.id,
          text: `${texts.reminderPrefix}${item.text}`,
          choices: [
            { id: `todo.done:${item.id}`, label: texts.doneChoiceLabel },
            { id: `todo.snooze:${item.id}`, label: texts.snoozeChoiceLabel },
          ],
        });
        await store.update({ ...item, reminded: true });
      }
    },
  });
}
