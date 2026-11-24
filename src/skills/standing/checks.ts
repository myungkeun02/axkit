import { Contracts } from '../../core/contracts/index.js';
import type { MailTriaged } from '../../core/contracts/mail-intents.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { judge } from './judge.js';
import type { OrderStore, StandingOrder } from './store.js';
import { lineHash } from './store.js';

const MAX_NEW_LINES = 40;
const MIN_LINE = 12;

function senderName(from: string): string {
  return (from.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || from).slice(0, 40);
}

async function tell(ctx: PluginContext, text: string, dedupeKey: string): Promise<void> {
  await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'standing.hit', text, dedupeKey }).catch(() => undefined);
}

async function record(store: OrderStore, order: StandingOrder, at: string): Promise<void> {
  await store.update(order.id, (item) => {
    item.hits += 1;
    item.lastHitAt = at;
  });
}

/** A mail the triage just read, against every mail order. */
export async function checkMail(ctx: PluginContext, store: OrderStore, mail: MailTriaged): Promise<number> {
  const now = ctx.clock.now();
  const orders = store.active(now, 'mail');
  if (orders.length === 0) return 0;
  const korean = ctx.assistant.language !== 'en';
  const item = `From: ${mail.from}\nSubject: ${mail.subject}\n${mail.summary}`;
  const hits = await judge({ llm: ctx.llm, log: ctx.log, korean }, orders, [item]);
  for (const hit of hits) {
    const order = orders.find((known) => known.id === hit.orderId);
    if (order === undefined) continue;
    const text = korean
      ? `말씀하신 "${order.text}"에 맞는 메일이 왔어요.\n${senderName(mail.from)}: ${mail.subject || '(제목 없음)'}\n${mail.summary}${hit.why !== '' ? `\n(${hit.why})` : ''}`
      : `A mail matches "${order.text}".\n${senderName(mail.from)}: ${mail.subject}\n${mail.summary}`;
    await tell(ctx, text, `standing:${order.id}:mail:${mail.id}`);
    await record(store, order, now.toISOString());
  }
  return hits.length;
}

/**
 * A page or a news search: only lines not seen before are judged. The first look learns what is already there and says
 * nothing, so an order never fires on old content.
 */
export async function checkPage(ctx: PluginContext, store: OrderStore, order: StandingOrder): Promise<number> {
  const reader = ctx.tryUse(Contracts.webPage);
  if (reader === undefined || order.url === undefined) return 0;
  const now = ctx.clock.now();
  let text: string;
  try {
    text = (await reader.read(order.url)).text;
  } catch (error) {
    ctx.log.warn('standing: a page could not be read', { error: error instanceof Error ? error.name : 'unknown' });
    return 0;
  }
  const lines = [...new Set(text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length >= MIN_LINE))];
  const seen = new Set(order.seen);
  const fresh = lines.filter((line) => !seen.has(lineHash(line)));
  const at = now.toISOString();
  if (!order.seeded) {
    await store.update(order.id, (item) => {
      item.seen = lines.map(lineHash);
      item.seeded = true;
      item.lastCheckedAt = at;
    });
    return 0;
  }
  const items = fresh.slice(0, MAX_NEW_LINES);
  const korean = ctx.assistant.language !== 'en';
  const hits = await judge({ llm: ctx.llm, log: ctx.log, korean }, [order], items);
  await store.update(order.id, (item) => {
    item.seen = [...item.seen, ...fresh.map(lineHash)];
    item.lastCheckedAt = at;
  });
  if (hits.length === 0) return 0;
  const found = hits.map((hit) => `• ${items[hit.item] ?? ''}${hit.why !== '' ? ` — ${hit.why}` : ''}`).slice(0, 5).join('\n');
  const where = order.source === 'news' ? (korean ? '뉴스' : 'news') : order.url;
  await tell(ctx, korean ? `말씀하신 "${order.text}" 소식이 있어요 (${where}).\n${found}` : `News on "${order.text}" (${where}).\n${found}`, `standing:${order.id}:${lineHash(found)}`);
  await record(store, order, at);
  return hits.length;
}
