import { Contracts } from '../../core/contracts/index.js';
import type { IncomingMessage, MessageHandler, Replier } from '../../core/conversation/types.js';
import type { ToolOutcome } from '../../core/tools/types.js';
import { ymdOf } from '../../core/time/local-day.js';
import type { ChatInboxDeps } from './deps.js';
import type { ChatInboxTexts } from './locale.js';
import type { ChatInboxStore } from './store.js';

const CHOICE = /^\(choice: chat-inbox\.([a-z.]+):(.+)\)$/;
const HANDLER_ID = 'chat-inbox.buttons';
const PRIORITY = 90;

async function say(replier: Replier, message: IncomingMessage, text: string): Promise<void> {
  await replier.reply(message.conversation, { text });
}

function outcomeText(outcome: ToolOutcome, texts: ChatInboxTexts, title: string): string {
  switch (outcome.status) {
    case 'done':
      return texts.eventAdded(title);
    case 'rejected':
      return texts.eventRejected(outcome.reason);
    case 'failed':
      return texts.eventFailed(outcome.error);
    case 'invalid_input':
      return texts.eventFailed(outcome.issues.join('; '));
    case 'denied':
    case 'expired':
      return texts.eventDenied;
  }
}

async function addAppointment(
  deps: ChatInboxDeps,
  id: string,
  message: IncomingMessage,
  replier: Replier,
): Promise<void> {
  const suggestion = deps.store.getSuggestion(id);
  if (suggestion === undefined) {
    await say(replier, message, deps.texts.unknownChoice);
    return;
  }

  const relative = suggestion.date.kind === 'offset' || suggestion.date.kind === 'weekday';
  const today = ymdOf(deps.ctx.clock.now(), deps.ctx.assistant.timezone);
  if (relative && suggestion.seenYmd !== undefined && suggestion.seenYmd !== today) {
    await deps.store.removeSuggestion(id);
    await say(replier, message, deps.texts.staleSuggestion);
    return;
  }

  const available = deps.ctx.tools.list().some((tool) => tool.name === 'calendar.add_event');
  if (!available) {
    await deps.store.removeSuggestion(id);
    await say(replier, message, deps.texts.calendarMissing);
    return;
  }

  const outcome = await deps.ctx.tools.execute(
    'calendar.add_event',
    {
      title: suggestion.title,
      date: suggestion.date,
      ...(suggestion.time !== undefined ? { time: suggestion.time } : {}),
      evidence: suggestion.evidence,
    },
    { grounding: [suggestion.text] },
  );
  await say(replier, message, outcomeText(outcome, deps.texts, suggestion.title));
  await deps.ctx.bus.emit('feedback.card', {
    domain: 'chat.appointment',
    subject: suggestion.room,
    verdict: 'accepted',
    label: suggestion.room,
    at: deps.ctx.clock.now(),
  });
  await deps.store.removeSuggestion(id);
}

async function rejectAppointment(
  deps: ChatInboxDeps,
  id: string,
  message: IncomingMessage,
  replier: Replier,
): Promise<void> {
  const suggestion = deps.store.getSuggestion(id);
  if (suggestion === undefined) {
    await say(replier, message, deps.texts.unknownChoice);
    return;
  }
  await deps.ctx.bus.emit('feedback.card', {
    domain: 'chat.appointment',
    subject: suggestion.room,
    verdict: 'rejected',
    at: deps.ctx.clock.now(),
  });
  await deps.store.removeSuggestion(id);
  await say(replier, message, deps.texts.appointmentDismissed);
}

async function markDone(
  store: ChatInboxStore,
  texts: ChatInboxTexts,
  key: string,
  message: IncomingMessage,
  replier: Replier,
): Promise<void> {
  const separator = key.indexOf(':');
  const room = separator < 0 ? key : key.slice(separator + 1);
  await store.removePending(key);
  await say(replier, message, texts.repliedDone(room));
}

async function muteReplies(deps: ChatInboxDeps, message: IncomingMessage, replier: Replier): Promise<void> {
  const muter = deps.ctx.tryUse(Contracts.noticeMute);
  if (muter === undefined) {
    await say(replier, message, deps.texts.muteUnavailable);
    return;
  }
  await muter.mute('chat.replies');
  await deps.ctx.bus.emit('feedback.card', {
    domain: 'notice',
    subject: 'chat.replies',
    verdict: 'rejected',
    at: deps.ctx.clock.now(),
  });
  await say(replier, message, deps.texts.muteRepliesDone);
}

/** Owner-only choice buttons on the appointment cards, the reply digest and its mute button. */
export function registerButtons(deps: ChatInboxDeps): void {
  const handler: MessageHandler = {
    id: HANDLER_ID,
    priority: PRIORITY,
    async handle(message, replier) {
      if (!message.fromOwner) return 'pass';
      const match = CHOICE.exec(message.text.trim());
      const action = match?.[1];
      const id = match?.[2];
      if (action === undefined || id === undefined) return 'pass';

      switch (action) {
        case 'appt.add':
          await addAppointment(deps, id, message, replier);
          return 'handled';
        case 'appt.no':
          await rejectAppointment(deps, id, message, replier);
          return 'handled';
        case 'done':
          await markDone(deps.store, deps.texts, id, message, replier);
          return 'handled';
        case 'mute':
          if (id === 'replies') {
            await muteReplies(deps, message, replier);
            return 'handled';
          }
          await say(replier, message, deps.texts.unknownChoice);
          return 'handled';
        default:
          await say(replier, message, deps.texts.unknownChoice);
          return 'handled';
      }
    },
  };
  deps.ctx.registerHandler(handler);
}
