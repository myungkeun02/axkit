import { randomUUID } from 'node:crypto';
import type { DeviceApi, DeviceApiResponse, DeviceCaller } from '../../core/contracts/device-api.js';
import type { IncomingMessage } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { AppConfirmer } from './confirm.js';
import type { AppTexts } from './locale.js';
import type { AppEventLog } from './log.js';
import type { Presence } from './presence.js';
import { PROTOCOL_VERSION, cardDecisionSchema, eventsQuerySchema, sendMessageSchema } from './protocol.js';
import { saveShare } from './share.js';
import { Contracts } from '../../core/contracts/index.js';
import { botAddress, meetingChannel } from '../../core/contracts/bots.js';
import type { AppActivity } from './activity.js';
import type { BotDirectory } from '../../core/contracts/bots.js';
import { OWNER_THREAD } from '../../core/conversation/thread.js';
import { ClientIds } from './client-ids.js';

export const CHANNEL_ID = 'channel.app';
export const OWNER_ADDRESS = 'owner';

export interface AppRouteDeps {
  ctx: PluginContext;
  log: AppEventLog;
  confirmer: AppConfirmer;
  presence: Presence;
  texts: AppTexts;
  inboxDir?: string;
  /** §4 `activity`: the "thinking / working" hint, live only. */
  activity?: AppActivity;
}

const bad = (error: string): DeviceApiResponse => ({ status: 400, body: { ok: false, error } });

/** A bot's room, a team room or a company's meeting room. */
async function roomExists(bots: BotDirectory | undefined, channel: string): Promise<boolean> {
  if (bots === undefined) return false;
  if ((await bots.get(channel)) !== undefined) return true;
  if ((await bots.teams()).some((team) => team.id === channel)) return true;
  return (await bots.groups()).some((group) => meetingChannel(group.id) === channel);
}

export function ownerMessage(caller: DeviceCaller, id: string, text: string, at: Date, channel?: string): IncomingMessage {
  return {
    id,
    // the main chat is the owner's own thread, shared with the Discord DM; a bot room keeps its own
    conversation: channel === undefined ? { channelId: CHANNEL_ID, address: OWNER_ADDRESS, replyTo: id, thread: OWNER_THREAD } : { channelId: CHANNEL_ID, address: botAddress(channel), replyTo: id },
    authorId: `app:${caller.deviceId}`,
    // Reaching these routes needs an app-paired token, which only the owner's own setup hands out.
    fromOwner: true,
    text,
    receivedAt: at,
  };
}

function originOf(caller: DeviceCaller): 'phone' | 'desktop' {
  return caller.platform === 'desktop' ? 'desktop' : 'phone';
}

async function choiceLabel(log: AppEventLog, choice: string): Promise<string> {
  const recent = await log.after(Math.max(0, (await log.lastSeq()) - 50), 50);
  for (const event of [...recent].reverse()) {
    if (event.type !== 'message' && event.type !== 'notice') continue;
    const found = event.choices?.find((candidate) => candidate.id === choice);
    if (found !== undefined) return found.label;
  }
  return choice;
}

/** Chat, cards, events and shares: the platform-neutral app protocol over the bridge's authenticated routes. */
export function registerAppRoutes(api: DeviceApi, deps: AppRouteDeps): void {
  const { ctx, log, confirmer, presence, texts } = deps;
  const clientIds = new ClientIds(ctx.kv, () => ctx.clock.now());

  // One stable id per installation (kept in this plugin's store), so apps tell Macs apart however they reach them.
  const serverId = (async () => {
    const stored = await ctx.kv.get<string>('server-id');
    if (typeof stored === 'string' && stored !== '') return stored;
    const fresh = randomUUID();
    await ctx.kv.set('server-id', fresh);
    return fresh;
  })();

  api.route('GET', 'status', async ({ caller }) => {
    await presence.touch(caller);
    return {
      status: 200,
      body: {
        ok: true,
        protocol: PROTOCOL_VERSION,
        assistant: { name: ctx.assistant.name, language: ctx.assistant.language, timezone: ctx.assistant.timezone },
        serverId: await serverId,
        lastSeq: await log.lastSeq(),
        serverTime: ctx.clock.now().toISOString(),
        // R10: the app shows a "stopped" band over every tab
        stopped: (await ctx.tryUse(Contracts.killSwitch)?.state().catch(() => ({ stopped: true })))?.stopped ?? false,
      },
    };
  });

  api.route('GET', 'events', async ({ caller, query }) => {
    const parsed = eventsQuerySchema.safeParse(Object.fromEntries(query));
    if (!parsed.success) return bad('query');
    await presence.touch(caller);
    const channel = parsed.data.channel;
    const all = await log.after(parsed.data.after, parsed.data.limit);
    // a room filter keeps only that room's messages; cards, notices and hand-offs always show
    const events = channel === undefined ? all : all.filter((event) => event.type !== 'message' || (event.channel ?? '') === channel);
    return { status: 200, body: { ok: true, events, lastSeq: await log.lastSeq(), oldestSeq: await log.oldestSeq() } };
  });

  api.route('POST', 'messages', async ({ caller, body }) => {
    const parsed = sendMessageSchema.safeParse(body);
    if (!parsed.success) return bad('shape');
    const { text, choice, shared, clientId, channel } = parsed.data;
    if (channel !== undefined && !(await roomExists(ctx.tryUse(Contracts.bots), channel))) return bad('shape');
    const now = ctx.clock.now();
    const intake = async (): Promise<number> => {
      const shown = choice !== undefined ? await choiceLabel(log, choice) : (text ?? '').trim();
      const event = await log.append({ type: 'message', role: 'owner', text: shown, ...(channel !== undefined ? { channel } : {}) });
      const routed = choice !== undefined ? `(choice: ${choice})` : shared === true ? texts.sharedText(shown, originOf(caller)) : shown;
      void ctx.bus.emit('message.received', ownerMessage(caller, `app:${event.seq}`, routed, now, channel));
      return event.seq;
    };
    // a resend with the same clientId (even after a restart) is the same message, never a second turn
    if (clientId === undefined) return { status: 200, body: { ok: true, seq: await intake() } };
    const { seq, duplicate } = await clientIds.once(clientId, intake);
    return { status: 200, body: duplicate ? { ok: true, seq, duplicate: true } : { ok: true, seq } };
  });

  api.route('POST', 'cards/:id', async ({ caller, params, body }) => {
    const parsed = cardDecisionSchema.safeParse(body);
    if (!parsed.success) return bad('shape');
    const { result, reply } = await confirmer.answer(params['id'] ?? '', parsed.data);
    if (result.state === 'gone') return { status: 410, body: { ok: false, error: 'gone' } };
    if (result.state === 'bad_option') return bad('option');
    if (reply !== undefined) {
      // the typed reply is the owner's next instruction: shown in the chat and handed to the assistant
      const event = await log.append({ type: 'message', role: 'owner', text: reply.text });
      void ctx.bus.emit('message.received', ownerMessage(caller, `app:${event.seq}`, texts.cardReply(reply.summary, reply.text), ctx.clock.now()));
      return { status: 200, body: { ok: true, state: result.state, reply: reply.text } };
    }
    return { status: 200, body: { ok: true, state: result.state, ...(result.answer !== undefined ? { answer: result.answer } : {}) } };
  });

  api.upload('share', async (upload) => {
    if (deps.inboxDir === undefined) return { status: 503, body: { ok: false, error: 'no_inbox' } };
    // a team or bot room (header x-channel); none means the main chat
    const room = upload.headers['x-channel']?.trim();
    const channel = room === undefined || room === '' ? undefined : room;
    if (channel !== undefined && !(await roomExists(ctx.tryUse(Contracts.bots), channel))) return bad('shape');
    const now = ctx.clock.now();
    const saved = await saveShare(deps.inboxDir, upload, now);
    await ctx.bus.emit('phone.shared_file', {
      deviceId: upload.caller.deviceId,
      path: saved.path,
      name: upload.name,
      contentType: upload.contentType,
      size: upload.bytes.length,
      at: now,
    });
    const text = texts.sharedFile(upload.name, saved.kind, originOf(upload.caller));
    const event = await log.append({ type: 'message', role: 'owner', text, ...(channel !== undefined ? { channel } : {}) });
    void ctx.bus.emit('message.received', ownerMessage(upload.caller, `app:${event.seq}`, text, now, channel));
    return { status: 200, body: { ok: true, seq: event.seq } };
  });

  api.stream('stream', (caller, stream, lastEventId) => {
    const after = Number(lastEventId ?? '0');
    presence.streamOpened(caller).catch(() => undefined);
    let lastSent = Number.isFinite(after) && after >= 0 ? after : 0;
    // D9: a Last-Event-ID past the log's end (the log started over: new install, data wiped) replays from the start
    // instead of waiting for a seq that may never come
    const resumed = log.lastSeq().then((last) => {
      if (lastSent > last) lastSent = 0;
    }, () => undefined);
    let replaying = true;
    const unsubscribe = log.subscribe((event) => {
      if (replaying || event.seq <= lastSent) return;
      lastSent = event.seq;
      stream.send(event.type, event, String(event.seq));
    });
    // live only, never replayed: no id, so Last-Event-ID stays the log's seq
    const unsubscribeActivity = deps.activity?.subscribe((event) => {
      if (!replaying) stream.send('activity', event);
    });
    stream.onClose(() => {
      unsubscribe();
      unsubscribeActivity?.();
      presence.streamClosed(caller).catch(() => undefined);
    });
    void (async () => {
      await resumed;
      // Replay what the client missed, then hand over to live events without a gap or a repeat.
      for (;;) {
        const missed = await log.after(lastSent, 200);
        for (const event of missed) {
          lastSent = event.seq;
          stream.send(event.type, event, String(event.seq));
        }
        if (missed.length < 200) break;
      }
      replaying = false;
      for (const event of await log.after(lastSent, 200)) {
        lastSent = event.seq;
        stream.send(event.type, event, String(event.seq));
      }
      for (const event of deps.activity?.snapshot() ?? []) stream.send('activity', event);
    })();
  });
}
