import type { ParcelStatus } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { SmsReaderTexts } from './locale.js';
import type { ParcelFound } from './types.js';

export const PARCEL_JOB = 'sms-reader.parcels';
export const PARCEL_TOOL = 'life.parcel';
const KEY = 'parcels';
const MAX_TRACKED = 20;
const MAX_AGE_MS = 14 * 86_400_000;

export interface TrackedParcel {
  carrier: string;
  invoice: string;
  state: string;
  addedAt: string;
}

export interface ParcelDeps {
  ctx: PluginContext;
  texts: SmsReaderTexts;
}

function statusOf(output: unknown): ParcelStatus | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const record = output as { status?: unknown; parcel?: unknown };
  if (record.status !== 'ok' || typeof record.parcel !== 'object' || record.parcel === null) return undefined;
  const parcel = record.parcel as Partial<ParcelStatus>;
  return typeof parcel.state === 'string' && typeof parcel.delivered === 'boolean' ? (parcel as ParcelStatus) : undefined;
}

/** Through the tool, so policy and audit apply; undefined when the lookup is not set up or failed. */
async function lookup(ctx: PluginContext, parcel: { carrier: string; invoice: string }): Promise<ParcelStatus | undefined> {
  const outcome = await ctx.tools.execute(PARCEL_TOOL, { carrier: parcel.carrier, invoice: parcel.invoice }, { grounding: [] });
  return outcome.status === 'done' ? statusOf(outcome.output) : undefined;
}

async function tell(ctx: PluginContext, text: string, dedupeKey: string): Promise<void> {
  await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'sms.parcel', text, dedupeKey }).catch(() => undefined);
}

async function tracked(ctx: PluginContext): Promise<TrackedParcel[]> {
  const stored = await ctx.kv.get<TrackedParcel[]>(KEY);
  return Array.isArray(stored) ? stored : [];
}

function sameParcel(a: { carrier: string; invoice: string }, b: { carrier: string; invoice: string }): boolean {
  return a.carrier === b.carrier && a.invoice === b.invoice;
}

/** The owner said yes: look it up once now, then keep following it until it is delivered. */
export async function followParcel(deps: ParcelDeps, parcel: ParcelFound): Promise<void> {
  const { ctx, texts } = deps;
  const status = await lookup(ctx, parcel);
  if (status === undefined) {
    await tell(ctx, texts.parcelUnavailable(parcel.carrier), `unavailable:${parcel.invoice}`);
    return;
  }
  if (status.delivered) {
    await tell(ctx, texts.parcelDelivered(parcel.carrier), `delivered:${parcel.invoice}`);
    return;
  }
  await tell(ctx, texts.parcelState(parcel.carrier, status.state, status.lastEvent?.where), `state:${parcel.invoice}:${status.state}`);
  const list = (await tracked(ctx)).filter((item) => !sameParcel(item, parcel));
  const entry: TrackedParcel = { carrier: parcel.carrier, invoice: parcel.invoice, state: status.state, addedAt: ctx.clock.now().toISOString() };
  await ctx.kv.set(KEY, [...list, entry].slice(-MAX_TRACKED));
}

/** Scheduled: tells the owner when a followed parcel moves on, and stops at delivery or after two weeks. */
export async function checkParcels(deps: ParcelDeps): Promise<void> {
  const { ctx, texts } = deps;
  const now = ctx.clock.now().getTime();
  const keep: TrackedParcel[] = [];
  for (const item of await tracked(ctx)) {
    if (now - Date.parse(item.addedAt) > MAX_AGE_MS) continue;
    const status = await lookup(ctx, item).catch(() => undefined);
    if (status === undefined) {
      keep.push(item);
      continue;
    }
    if (status.delivered) {
      await tell(ctx, texts.parcelDelivered(item.carrier), `delivered:${item.invoice}`);
      continue;
    }
    if (status.state !== item.state) {
      await tell(ctx, texts.parcelState(item.carrier, status.state, status.lastEvent?.where), `state:${item.invoice}:${status.state}`);
    }
    keep.push({ ...item, state: status.state });
  }
  await ctx.kv.set(KEY, keep);
}
