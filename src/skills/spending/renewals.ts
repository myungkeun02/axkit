import { createHash } from 'node:crypto';
import { Contracts } from '../../core/contracts/index.js';
import type { Notice, Notifier } from '../../core/contracts/index.js';
import type { IncomingMessage, MessageHandler, Replier } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import { daysFromTo, ymdOf } from '../../core/time/local-day.js';
import type { SpendingConfig } from './config.js';
import type { DetectDeps } from './detect.js';
import { loadDetected } from './detect.js';
import { shortDateOf } from './format.js';
import { manageUrl } from './manage.js';
import type { SpendingTexts } from './locale.js';
import { DAY_MS } from './subscriptions.js';
import type { DetectedSubscription } from './subscriptions.js';

export const RENEWAL_JOB = 'spending.subscriptions';
export const SUBSCRIPTIONS_HANDLER_ID = 'spending.subscriptions';
export const SUBSCRIPTIONS_PRIORITY = 73;
const IDS_KEY = 'subs:ids';
const MUTED_KEY = 'subs:muted';
const PRICE_UPS_KEY = 'subs:priceUps';
const IDS_CAP = 200;
const MUTED_CAP = 200;
const PRICE_UPS_CAP = 500;
const CHOICE = /^\(choice:\s*spend\.sub\.(keep|cancel):([A-Za-z0-9_-]{1,60})\)$/;
const PRICE_RISE = 1.03;

export interface RenewalDeps {
  config: SpendingConfig;
  ledger: DetectDeps['ledger'];
  texts: SpendingTexts;
  timeZone: string;
}

interface SubIdRecord {
  key: string;
  merchant: string;
}

type MuteMap = Record<string, string>;

function shortId(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

async function readRecord<T>(kv: KeyValueStore, key: string): Promise<Record<string, T>> {
  const raw = await kv.get<Record<string, T>>(key);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw;
}

function capped<T>(map: Record<string, T>, cap: number): Record<string, T> {
  const keys = Object.keys(map);
  if (keys.length <= cap) return map;
  const kept: Record<string, T> = {};
  for (const key of keys.slice(-cap)) {
    const value = map[key];
    if (value !== undefined) kept[key] = value;
  }
  return kept;
}

function isMuted(muted: MuteMap, key: string, now: Date): boolean {
  const until = muted[key];
  if (until === undefined || Number.isNaN(Date.parse(until))) return false;
  return Date.parse(until) > now.getTime();
}

async function announcePriceUps(
  ctx: PluginContext,
  deps: RenewalDeps,
  subs: readonly DetectedSubscription[],
  notifier: Notifier,
): Promise<void> {
  const stored = await ctx.kv.get<string[]>(PRICE_UPS_KEY);
  const announced = Array.isArray(stored) ? [...stored] : [];
  const known = new Set(announced);
  let changed = false;
  for (const sub of subs) {
    const previous = sub.prevAmount;
    if (previous === null || previous <= 0) continue;
    if (sub.amount < previous * PRICE_RISE) continue;
    const ref = `${sub.key}|${sub.lastAt.toISOString()}`;
    if (known.has(ref)) continue;
    await notifier.notify({
      kind: 'spending.price_up',
      dedupeKey: ref,
      text: deps.texts.priceUpLine(
        sub.merchant,
        deps.texts.money(previous, sub.currency),
        deps.texts.money(sub.amount, sub.currency),
      ),
    });
    announced.push(ref);
    known.add(ref);
    changed = true;
  }
  if (changed) await ctx.kv.set(PRICE_UPS_KEY, announced.slice(-PRICE_UPS_CAP));
}

async function runRenewals(ctx: PluginContext, deps: RenewalDeps, now: Date): Promise<void> {
  const subs = await loadDetected(
    { ledger: deps.ledger, timeZone: deps.timeZone, homeCurrency: deps.config.homeCurrency },
    now,
  );
  if (subs.length === 0) return;
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    ctx.log.warn('spending renewals: no notifier available');
    return;
  }

  const today = ymdOf(now, deps.timeZone);
  const muted = await readRecord<string>(ctx.kv, MUTED_KEY);
  const ids = await readRecord<SubIdRecord>(ctx.kv, IDS_KEY);
  let idsChanged = false;

  for (const sub of subs) {
    if (sub.lapsed || isMuted(muted, sub.key, now)) continue;
    if (daysFromTo(today, ymdOf(sub.nextAt, deps.timeZone)) !== deps.config.renewalNoticeDays) continue;
    const id = shortId(sub.key);
    ids[id] = { key: sub.key, merchant: sub.merchant };
    idsChanged = true;
    const notice: Notice = {
      kind: 'spending.renewal',
      dedupeKey: `${sub.key}:${ymdOf(sub.nextAt, deps.timeZone)}`,
      text: deps.texts.renewalLine(
        shortDateOf(sub.nextAt, deps.timeZone),
        sub.merchant,
        deps.texts.money(sub.amount, sub.currency),
        sub.cadence,
      ),
      choices: [
        { id: `spend.sub.keep:${id}`, label: deps.texts.renewalKeepLabel },
        { id: `spend.sub.cancel:${id}`, label: deps.texts.renewalCancelLabel },
      ],
    };
    await notifier.notify(notice);
  }
  if (idsChanged) await ctx.kv.set(IDS_KEY, capped(ids, IDS_CAP));
  await announcePriceUps(ctx, deps, subs, notifier);
}

async function muteUntilNextCycle(ctx: PluginContext, deps: RenewalDeps, key: string): Promise<void> {
  const now = ctx.clock.now();
  const subs = await loadDetected(
    { ledger: deps.ledger, timeZone: deps.timeZone, homeCurrency: deps.config.homeCurrency },
    now,
  );
  const found = subs.find((sub) => sub.key === key);
  const until = found === undefined ? now.getTime() + 40 * DAY_MS : found.nextAt.getTime() + DAY_MS;
  const muted = await readRecord<string>(ctx.kv, MUTED_KEY);
  muted[key] = new Date(until).toISOString();
  await ctx.kv.set(MUTED_KEY, capped(muted, MUTED_CAP));
}

function cancelGuidance(merchant: string, texts: SpendingTexts): string {
  const url = manageUrl(merchant);
  const line = url === undefined ? texts.manageGeneric(merchant) : texts.manageUrlLine(merchant, url);
  return `${line}\n${texts.cancelNote}`;
}

async function reply(replier: Replier, message: IncomingMessage, text: string): Promise<void> {
  await replier.reply(message.conversation, { text });
}

/** Registers the daily renewal/price-rise job and the owner-only keep/cancel buttons. */
export function registerRenewals(ctx: PluginContext, deps: RenewalDeps): void {
  ctx.scheduler.add({
    name: RENEWAL_JOB,
    schedule: { kind: 'daily', at: deps.config.renewalAt as `${number}:${number}` },
    run: (now) => runRenewals(ctx, deps, now),
  });

  const handler: MessageHandler = {
    id: SUBSCRIPTIONS_HANDLER_ID,
    priority: SUBSCRIPTIONS_PRIORITY,
    async handle(message, replier) {
      if (!message.fromOwner) return 'pass';
      const match = CHOICE.exec(message.text.trim());
      if (match === null) return 'pass';
      const action = match[1];
      const id = match[2];
      if (id === undefined || (action !== 'keep' && action !== 'cancel')) return 'pass';

      const ids = await readRecord<SubIdRecord>(ctx.kv, IDS_KEY);
      const record = ids[id];
      if (record === undefined) {
        await reply(replier, message, deps.texts.renewalGone);
        return 'handled';
      }
      if (action === 'keep') {
        await muteUntilNextCycle(ctx, deps, record.key);
        await reply(replier, message, deps.texts.renewalKept(record.merchant));
      } else {
        await reply(replier, message, cancelGuidance(record.merchant, deps.texts));
      }
      return 'handled';
    },
  };
  ctx.registerHandler(handler);
}
