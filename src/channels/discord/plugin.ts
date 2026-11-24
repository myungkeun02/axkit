import type { IncomingMessage } from '../../core/conversation/types.js';
import { OWNER_THREAD } from '../../core/conversation/thread.js';
import type { Plugin, PluginContext } from '../../core/plugin/types.js';
import { Caps } from '../../core/plugin/types.js';
import { DiscordConfirmer } from './confirm.js';
import { createDiscordJsPort } from './discordjs-port.js';
import { confirmTexts } from './locale.js';
import type { DiscordButtonPress, DiscordInbound, DiscordPort } from './port.js';
import { toOutbound } from './render.js';

export interface DiscordChannelOptions {
  ownerUserId: string;
  /** Tests inject a fake; production builds a discord.js client lazily. */
  port?: () => DiscordPort;
  expiresMinutes: number;
}

const CHANNEL_ID = 'channel.discord';
const BOT_TOKEN_SECRET = 'discord.bot-token';
const CHOICE_PREFIX = 'choice:';

/** Opening a DM is a network call, so the id is resolved once and reused. */
function cachedDm(port: DiscordPort, userId: string): () => Promise<string> {
  let open: Promise<string> | undefined;
  return () => {
    open ??= port.openDm(userId).catch((error: unknown) => {
      open = undefined;
      throw error;
    });
    return open;
  };
}

function handleMessage(ctx: PluginContext, ownerUserId: string, inbound: DiscordInbound): void {
  if (inbound.authorIsBot) return;
  // the owner's DM is the owner's own thread, shared with the app's main chat; this channel only routes the reply
  const thread = inbound.isDm && inbound.authorId === ownerUserId ? { thread: OWNER_THREAD } : {};
  const message: IncomingMessage = {
    id: inbound.id,
    conversation: { channelId: CHANNEL_ID, address: inbound.channelId, replyTo: inbound.id, ...thread },
    authorId: inbound.authorId,
    fromOwner: inbound.authorId === ownerUserId,
    text: inbound.content,
    receivedAt: inbound.createdAt,
  };
  void ctx.bus.emit('message.received', message);
}

const CATCH_UP_WITHIN_MS = 12 * 60 * 60 * 1000;
const LATE_NOTE_KO = '(제가 꺼져 있는 동안 보내신 메시지예요. 늦게 답해요) ';
const LATE_NOTE_EN = '(Sent while I was off; answering late) ';

/**
 * Owner messages at the end of the DM that no bot message follows: sent while the server was down. Each is handed to
 * the assistant once (the newest few, within 12 hours); anything the bot already answered is left alone.
 */
export async function catchUp(ctx: PluginContext, port: DiscordPort, ownerDm: () => Promise<string>, ownerUserId: string): Promise<number> {
  if (port.recent === undefined) return 0;
  const channelId = await ownerDm();
  const recent = await port.recent(channelId, 20);
  const unanswered: DiscordInbound[] = [];
  for (const message of recent) {
    if (message.authorIsBot) break;
    if (message.authorId === ownerUserId) unanswered.push(message);
  }
  const now = ctx.clock.now().getTime();
  const seen = (await ctx.kv.get<string[]>('caught-up')) ?? [];
  const due = unanswered.filter((message) => now - message.createdAt.getTime() <= CATCH_UP_WITHIN_MS && !seen.includes(message.id)).reverse().slice(-3);
  if (due.length === 0) return 0;
  await ctx.kv.set('caught-up', [...seen, ...due.map((message) => message.id)].slice(-100));
  const note = ctx.assistant.language === 'en' ? LATE_NOTE_EN : LATE_NOTE_KO;
  for (const message of due) handleMessage(ctx, ownerUserId, { ...message, content: `${note}${message.content}` });
  return due.length;
}

async function handleButton(
  ctx: PluginContext,
  confirmer: DiscordConfirmer,
  ownerUserId: string,
  press: DiscordButtonPress,
  ownerDm: () => Promise<string>,
): Promise<void> {
  if (await confirmer.handleButton(press)) return;

  try {
    await press.ack();
  } catch {
    // The interaction may already be acknowledged or expired.
  }

  if (press.userId !== ownerUserId || !press.customId.startsWith(CHOICE_PREFIX)) return;
  const choiceId = press.customId.slice(CHOICE_PREFIX.length);
  const inDm = press.channelId === (await ownerDm().catch(() => undefined));
  const message: IncomingMessage = {
    id: `button:${press.messageId}`,
    conversation: { channelId: CHANNEL_ID, address: press.channelId, replyTo: press.messageId, ...(inDm ? { thread: OWNER_THREAD } : {}) },
    authorId: press.userId,
    fromOwner: true,
    text: `(choice: ${choiceId.length > 0 ? choiceId : press.customId})`,
    receivedAt: new Date(),
  };
  await ctx.bus.emit('message.received', message);
}

export function discordChannel(opts: DiscordChannelOptions): Plugin {
  return {
    manifest: {
      id: CHANNEL_ID,
      kind: 'channel',
      title: 'Discord',
      secrets: [BOT_TOKEN_SECRET],
    },
    setup(ctx) {
      const port = opts.port?.() ?? createDiscordJsPort();
      const confirmer = new DiscordConfirmer({
        port,
        ownerUserId: opts.ownerUserId,
        expiresMs: opts.expiresMinutes * 60_000,
        texts: confirmTexts(ctx.assistant.language),
      });

      const ownerDm = cachedDm(port, opts.ownerUserId);
      ctx.use(Caps.channels).register({
        id: CHANNEL_ID,
        replier: {
          async reply(to, message) {
            for (const chunk of toOutbound(message, 'choice')) {
              await port.send(to.address, chunk);
            }
          },
        },
        owner: {
          async send(message) {
            const channelId = await ownerDm();
            for (const chunk of toOutbound(message, 'choice')) {
              await port.send(channelId, chunk);
            }
          },
        },
        confirmer,
      });

      return {
        async start() {
          const token = await ctx.secrets.get(BOT_TOKEN_SECRET);
          if (token === undefined) {
            throw new Error('Discord bot token is missing. Run: ax-kit secret set discord.bot-token');
          }
          port.onMessage((inbound) => {
            handleMessage(ctx, opts.ownerUserId, inbound);
          });
          port.onButton((press) => {
            void handleButton(ctx, confirmer, opts.ownerUserId, press, ownerDm);
          });
          await port.login(token);
          // DMs the owner sent while this server was off: answered once, after everything else has started
          ctx.bus.on('app.started', () => void catchUp(ctx, port, ownerDm, opts.ownerUserId).catch(() => undefined));
        },
        async stop() {
          await port.destroy();
        },
      };
    },
  };
}
