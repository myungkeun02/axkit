import type { MessageHandler } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { wallClock } from '../../core/scheduler/next-run.js';
import { zonedIso } from '../../core/time/date-spec.js';
import type { TodoTexts } from './locale.js';
import type { TodoRepo } from './store.js';

const CHOICE = /^\(choice: todo\.(done|snooze):(.+)\)$/;
const HANDLER_ID = 'todo.buttons';
const PRIORITY = 90;
const SNOOZE_MINUTES = 10;
const MINUTE_MS = 60_000;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** The owner's zone offset is what the reminder sweep compares against, so the snooze time carries it too. */
function snoozeIso(now: Date, timeZone: string): string {
  const target = new Date(now.getTime() + SNOOZE_MINUTES * MINUTE_MS);
  const wall = wallClock(target, timeZone);
  const ymd = `${String(wall.y).padStart(4, '0')}-${pad2(wall.m)}-${pad2(wall.d)}`;
  return zonedIso(ymd, `${pad2(wall.hh)}:${pad2(wall.mm)}`, timeZone);
}

/** Buttons on the reminder notice: the owner's press is an answer, so it needs no confirmation card. */
export function registerTodoButtons(ctx: PluginContext, store: TodoRepo, texts: TodoTexts): void {
  const handler: MessageHandler = {
    id: HANDLER_ID,
    priority: PRIORITY,
    async handle(message, replier) {
      if (!message.fromOwner) return 'pass';
      const match = CHOICE.exec(message.text.trim());
      if (match === null) return 'pass';
      const [, action, id] = match;
      if (action === undefined || id === undefined) return 'pass';

      let item = store.get(id);
      if (item === undefined) {
        await store.sync(0);
        item = store.get(id);
      }
      if (item === undefined) {
        await replier.reply(message.conversation, { text: texts.unknownItem });
        return 'handled';
      }
      if (item.done) {
        await replier.reply(message.conversation, { text: texts.alreadyDone });
        return 'handled';
      }

      if (action === 'done') {
        await store.update({ ...item, done: true, completedAt: ctx.clock.now().toISOString() });
        await replier.reply(message.conversation, { text: `${texts.doneReplyPrefix}${item.text}` });
        return 'handled';
      }

      const remindAt = snoozeIso(ctx.clock.now(), ctx.assistant.timezone);
      await store.update({ ...item, remindAt, reminded: false });
      await replier.reply(message.conversation, { text: `${texts.snoozeReplyPrefix}${item.text}` });
      return 'handled';
    },
  };
  ctx.registerHandler(handler);
}
