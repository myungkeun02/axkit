import type { ChatPreview, PhoneSms } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { ChatInboxDeps } from './deps.js';
import { shortId } from './ids.js';
import { isCardRoom, isGroupRoom, looksLikeAppointment } from './rooms.js';
import { oneLine } from './snippet.js';
import { roomKey } from './store.js';

const LAST_TEXT_CHARS = 60;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.name : 'error';
}

function isCardNotice(preview: ChatPreview): boolean {
  return preview.app === 'kakao' && preview.text.trim() !== '' && isCardRoom(preview.room);
}

/** Card alerts feed the spending skill only; they never become contacts, pending replies or appointments. */
async function emitCardNotice(deps: ChatInboxDeps, preview: ChatPreview): Promise<void> {
  await deps.ctx.bus.emit('money.notice', {
    source: 'chat',
    sender: preview.room,
    text: preview.text,
    at: preview.at,
    ref: preview.ref,
  });
}

/** Code-written summary only: the message body is never copied into contact memory. */
async function noteContact(deps: ChatInboxDeps, preview: ChatPreview): Promise<void> {
  if (preview.direct === false || isGroupRoom(preview.room)) return;
  const people = deps.ctx.tryUse(Contracts.peopleWrite);
  if (people === undefined) return;
  try {
    await people.noteInteraction(
      { name: preview.room },
      {
        at: preview.at.toISOString(),
        channel: 'chat',
        summary: deps.texts.interactionSummary(preview.app),
        ref: preview.ref,
      },
    );
  } catch (error) {
    deps.ctx.log.warn('chat-inbox: contact note failed', { error: errorMessage(error) });
  }
}

async function queueAppointment(deps: ChatInboxDeps, preview: ChatPreview): Promise<void> {
  if (!deps.config.appointments) return;
  if (deps.store.isMuted(preview.app, preview.room)) return;
  if (!looksLikeAppointment(preview.text)) return;
  await deps.store.enqueue({
    id: shortId(`queue:${preview.ref}`),
    app: preview.app,
    room: preview.room,
    text: preview.text,
    at: preview.at.toISOString(),
    ref: preview.ref,
    tries: 0,
  });
}

/** One screen-read preview: card notice, or contact + pending reply + possible appointment. */
export async function handlePreview(deps: ChatInboxDeps, preview: ChatPreview): Promise<void> {
  if (isCardNotice(preview)) {
    await emitCardNotice(deps, preview);
    return;
  }

  const key = roomKey(preview.app, preview.room);
  if (preview.unread === 0) {
    await deps.store.removePending(key);
    return;
  }

  await noteContact(deps, preview);
  await deps.store.upsertPending({
    app: preview.app,
    room: preview.room,
    firstAt: preview.at.toISOString(),
    lastText: oneLine(preview.text).slice(0, LAST_TEXT_CHARS),
    unread: preview.unread ?? 0,
  });
  await queueAppointment(deps, preview);
}

/**
 * A forwarded text message into the same appointment queue: quoted evidence, DateSpec, dedupe and a confirmation card.
 * The bridge already dropped codes, card approvals and spam; SMS never becomes a contact or a pending reply.
 */
export async function handleSms(deps: ChatInboxDeps, sms: PhoneSms): Promise<void> {
  if (!deps.config.appointments || !deps.config.sms) return;
  const room = (sms.from ?? '').trim().slice(0, 60) || deps.texts.smsUnknownSender;
  if (deps.store.isMuted('sms', room)) return;
  if (!looksLikeAppointment(sms.text)) return;
  await deps.store.enqueue({
    id: shortId(`queue:${sms.ref}`),
    app: 'sms',
    room,
    text: sms.text,
    at: sms.at.toISOString(),
    ref: sms.ref,
    tries: 0,
  });
}
