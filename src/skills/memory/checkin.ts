import type {
  HandleResult,
  IncomingMessage,
  MessageHandler,
  Replier,
} from '../../core/conversation/types.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import { ymdOf, weekdayOf } from '../../core/time/local-day.js';
import type { FactStore, StoredFact } from './facts.js';
import { strengthOf } from './facts.js';
import type { MemoryTexts } from './locale.js';

export const CHECKIN_JOB = 'memory.checkin';
export const CHECKIN_HANDLER = 'memory.checkin';
export const CHECKIN_PRIORITY = 72;

const ASKED_KEY = 'checkin:asked';
const ASKED_CAP = 2000;
const ASKED_WINDOW_MS = 60 * 86_400_000;
const MAX_FACTS = 2;
const MIN_STRENGTH = 0.15;
const MAX_STRENGTH = 0.5;
const CHECKIN_SOURCES = new Set(['interview', 'manual', 'chat']);
const CHOICE = /^\(choice:\s*mem\.(keep|forget):([A-Za-z0-9_-]{1,60})\)$/;

export interface CheckinSettings {
  /** HH:MM in the owner's zone. */
  at: string;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

type AskedMap = Record<string, string>;

function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

async function loadAsked(kv: KeyValueStore): Promise<AskedMap> {
  const stored = await kv.get<unknown>(ASKED_KEY);
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return {};
  const asked: AskedMap = {};
  for (const [id, at] of Object.entries(stored)) {
    if (isIsoInstant(at)) asked[id] = at;
  }
  return asked;
}

async function markAsked(kv: KeyValueStore, ids: readonly string[], now: Date): Promise<void> {
  const asked = await loadAsked(kv);
  const iso = now.toISOString();
  for (const id of ids) asked[id] = iso;
  const newest = Object.entries(asked)
    .sort((left, right) => left[1].localeCompare(right[1]))
    .slice(-ASKED_CAP);
  await kv.set(ASKED_KEY, Object.fromEntries(newest));
}

function wasAskedRecently(asked: AskedMap, id: string, now: Date): boolean {
  const at = asked[id];
  if (at === undefined) return false;
  return now.getTime() - Date.parse(at) < ASKED_WINDOW_MS;
}

/**
 * Owner facts to ask about: expired ones first (any source), then faded ones, skipping anything asked
 * about in the last 60 days. A fact built on a passed end condition is the one that most needs review.
 */
export function selectCheckinFacts(
  facts: readonly StoredFact[],
  asked: AskedMap,
  now: Date,
): StoredFact[] {
  const available = facts.filter((fact) => !wasAskedRecently(asked, fact.id, now));
  const expired = available
    .filter((fact) => fact.subject === 'owner' && fact.expiredAt !== undefined)
    .sort(
      (left, right) =>
        (left.expiredAt ?? '').localeCompare(right.expiredAt ?? '') ||
        left.confirmedAt.localeCompare(right.confirmedAt),
    );
  const faded = available
    .filter((fact) => fact.expiredAt === undefined)
    .filter((fact) => fact.subject === 'owner' && CHECKIN_SOURCES.has(fact.source.kind))
    .filter((fact) => {
      const strength = strengthOf(fact, now);
      return strength >= MIN_STRENGTH && strength <= MAX_STRENGTH;
    })
    .sort(
      (left, right) =>
        strengthOf(left, now) - strengthOf(right, now) ||
        left.confirmedAt.localeCompare(right.confirmedAt),
    );
  return [...expired, ...faded].slice(0, MAX_FACTS);
}

function noticeText(facts: readonly StoredFact[], texts: MemoryTexts): string {
  const lines = facts.map((fact) =>
    fact.expiredAt === undefined
      ? `• ${fact.text}`
      : `• ${fact.text} (${texts.checkinExpiredMark})`,
  );
  return [texts.checkinTitle, texts.checkinQuestion, '', ...lines].join('\n');
}

async function runCheckin(
  ctx: PluginContext,
  store: FactStore,
  texts: MemoryTexts,
  settings: CheckinSettings,
  now: Date,
): Promise<void> {
  const timeZone = ctx.assistant.timezone;
  if (weekdayOf(now, timeZone) !== settings.weekday) return;

  const asked = await loadAsked(ctx.kv);
  const facts = selectCheckinFacts(store.all(), asked, now);
  if (facts.length === 0) return;

  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    ctx.log.warn('memory checkin: no notifier available');
    return;
  }

  const choices = facts.flatMap((fact) => [
    { id: `mem.keep:${fact.id}`, label: texts.checkinKeepLabel },
    { id: `mem.forget:${fact.id}`, label: texts.checkinForgetLabel },
  ]);
  const result = await notifier.notify({
    kind: CHECKIN_JOB,
    dedupeKey: `${CHECKIN_JOB}:${ymdOf(now, timeZone)}`,
    text: noticeText(facts, texts),
    choices,
  });
  if (result === 'sent') {
    await markAsked(ctx.kv, facts.map((fact) => fact.id), now);
  }
}

async function handleKeep(
  store: FactStore,
  texts: MemoryTexts,
  id: string,
  replier: Replier,
  message: IncomingMessage,
): Promise<void> {
  const fact = store.get(id);
  if (fact === undefined) {
    await replier.reply(message.conversation, { text: texts.checkinGone });
    return;
  }
  try {
    await store.remember({
      subject: fact.subject,
      text: fact.text,
      source: fact.source,
      halfLifeDays: fact.halfLifeDays,
    });
  } catch {
    await replier.reply(message.conversation, { text: texts.checkinFailed });
    return;
  }
  await replier.reply(message.conversation, { text: texts.checkinKept(fact.text) });
}

async function handleForget(
  ctx: PluginContext,
  store: FactStore,
  texts: MemoryTexts,
  id: string,
  replier: Replier,
  message: IncomingMessage,
): Promise<void> {
  const fact = store.get(id);
  if (fact === undefined) {
    await replier.reply(message.conversation, { text: texts.checkinGone });
    return;
  }
  const outcome = await ctx.tools.execute('memory.forget', { id });
  if (outcome.status === 'done') {
    await replier.reply(message.conversation, { text: texts.checkinForgotten(fact.text) });
  } else if (outcome.status === 'denied' || outcome.status === 'expired') {
    await replier.reply(message.conversation, { text: texts.checkinKeptAsIs });
  } else {
    await replier.reply(message.conversation, { text: texts.checkinFailed });
  }
}

function checkinHandler(ctx: PluginContext, store: FactStore, texts: MemoryTexts): MessageHandler {
  return {
    id: CHECKIN_HANDLER,
    priority: CHECKIN_PRIORITY,
    handle: async (message, replier): Promise<HandleResult> => {
      if (!message.fromOwner) return 'pass';
      const match = CHOICE.exec(message.text.trim());
      if (match?.[1] === undefined || match[2] === undefined) return 'pass';
      if (match[1] === 'keep') {
        await handleKeep(store, texts, match[2], replier, message);
      } else {
        await handleForget(ctx, store, texts, match[2], replier, message);
      }
      return 'handled';
    },
  };
}

/** Registers the weekly fading-fact check-in and its keep/forget buttons. */
export function registerCheckin(
  ctx: PluginContext,
  store: FactStore,
  texts: MemoryTexts,
  settings: CheckinSettings,
): void {
  ctx.registerHandler(checkinHandler(ctx, store, texts));
  ctx.scheduler.add({
    name: CHECKIN_JOB,
    schedule: { kind: 'daily', at: settings.at as `${number}:${number}` },
    async run(now) {
      await runCheckin(ctx, store, texts, settings, now);
    },
  });
}
