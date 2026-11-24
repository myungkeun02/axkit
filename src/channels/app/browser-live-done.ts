import { botAddress, botOfAddress } from '../../core/contracts/bots.js';
import type { ConversationRef, IncomingMessage } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { Caps } from '../../core/plugin/types.js';
import type { AppEventLog } from './log.js';
import { CHANNEL_ID, OWNER_ADDRESS } from './routes.js';

/** The owner's "carry on" after the live view, in the words of the owner's language. */
export interface DoneTexts {
  done(host: string | undefined): string;
  /** Appended when the errand's own conversation cannot be reached (a routine, a removed channel). */
  fallback: string;
  /** Shown in the app's main chat when the errand continues in another channel's conversation. */
  elsewhere(channel: string): string;
  /** Posted in that other channel's conversation first, so the owner sees there why the assistant carries on. */
  resumed(host: string | undefined): string;
}

export const DONE_KO: DoneTexts = {
  done: (host) => `(앱의 브라우저 화면에서 직접 마쳤어요${host !== undefined ? `: ${host}` : ''}) 계속해 주세요.`,
  fallback: ' (처음 시킨 대화로는 보낼 수 없어서 여기서 이어 가요.)',
  elsewhere: (channel) => `브라우저 화면에서 마친 일은 ${channel} 대화에서 이어 갈게요.`,
  resumed: (host) => `(앱의 브라우저 화면에서 직접 마쳤어요${host !== undefined ? `: ${host}` : ''}) 이어서 할게요.`,
};

export const DONE_EN: DoneTexts = {
  done: (host) => `(I finished it myself in the app's browser screen${host !== undefined ? `: ${host}` : ''}) Please continue.`,
  fallback: " (The conversation this errand came from can't be reached, so it continues here.)",
  elsewhere: (channel) => `The errand you finished in the browser screen continues in ${channel}.`,
  resumed: (host) => `(You finished it in the app's browser screen${host !== undefined ? `: ${host}` : ''}) Carrying on.`,
};

const CHANNEL_NAMES: Record<string, { ko: string; en: string }> = {
  'channel.discord': { ko: '디스코드', en: 'Discord' },
};

/** Where the "carry on" line goes: `room` is the app room (absent = main chat); `other` is another channel's chat. */
export type ContinueTarget =
  | { kind: 'app'; room?: string; fallback: boolean }
  | { kind: 'other'; conversation: ConversationRef };

/**
 * The conversation the errand came from: the app's main chat or a room, another channel's conversation (Discord)
 * when that channel is running, else the app (the bot's room for a bot's errand) with a note saying so.
 */
export function continueTarget(origin: ConversationRef | undefined, channels: readonly string[]): ContinueTarget {
  if (origin === undefined) return { kind: 'app', fallback: false };
  const room = botOfAddress(origin.address);
  if (origin.channelId === CHANNEL_ID) return { kind: 'app', ...(room !== undefined ? { room } : {}), fallback: false };
  if (channels.includes(origin.channelId)) return { kind: 'other', conversation: { channelId: origin.channelId, address: origin.address } };
  return { kind: 'app', ...(room !== undefined ? { room } : {}), fallback: true };
}

export interface ContinueDeps {
  ctx: PluginContext;
  log: AppEventLog;
  texts: DoneTexts;
}

/**
 * Posts the owner's "carry on" line where the errand came from and hands it to the assistant like a typed line.
 * Returns where it went, for the `done` answer. The line never holds what the owner typed on the page.
 */
export async function postContinue(
  deps: ContinueDeps,
  origin: ConversationRef | undefined,
  host: string | undefined,
): Promise<{ continuedIn: 'app' | 'elsewhere'; channel?: string }> {
  const { ctx, log, texts } = deps;
  const channels = ctx.tryUse(Caps.channels)?.ids() ?? [];
  const target = continueTarget(origin, channels);
  const at = ctx.clock.now();
  const base = texts.done(host);
  if (target.kind === 'other') {
    const names = CHANNEL_NAMES[target.conversation.channelId];
    const name = names === undefined ? target.conversation.channelId : ctx.assistant.language === 'en' ? names.en : names.ko;
    await log.append({ type: 'notice', text: texts.elsewhere(name) });
    // the line shows in that conversation through its own channel, before the assistant's answer; never page text
    await ctx
      .tryUse(Caps.replier)
      ?.reply(target.conversation, { text: texts.resumed(host) })
      .catch((error: unknown) => ctx.log.warn('browser-live: could not post the continue line', { channel: target.conversation.channelId, error: error instanceof Error ? error.name : 'error' }));
    emit(ctx, { id: `browser-live:${at.getTime()}`, conversation: target.conversation, text: base, at });
    return { continuedIn: 'elsewhere' };
  }
  const text = target.fallback ? `${base}${texts.fallback}` : base;
  const event = await log.append({ type: 'message', role: 'owner', text, ...(target.room !== undefined ? { channel: target.room } : {}) });
  const address = target.room !== undefined ? botAddress(target.room) : OWNER_ADDRESS;
  const id = `app:${event.seq}`;
  emit(ctx, { id, conversation: { channelId: CHANNEL_ID, address, replyTo: id }, text, at });
  return { continuedIn: 'app', ...(target.room !== undefined ? { channel: target.room } : {}) };
}

function emit(ctx: PluginContext, line: { id: string; conversation: ConversationRef; text: string; at: Date }): void {
  const message: IncomingMessage = {
    id: line.id,
    conversation: line.conversation,
    authorId: 'app:browser-live',
    // only the owner's paired app reaches the done route
    fromOwner: true,
    text: line.text,
    receivedAt: line.at,
  };
  // not awaited by the route: the assistant's whole turn runs behind it
  void ctx.bus.emit('message.received', message);
}
