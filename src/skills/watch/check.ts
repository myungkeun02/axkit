import type { PriceOffer } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { WatchDeps } from './deps.js';
import type { Watch, WatchLast } from './types.js';
import { MAX_PAGE_LINES } from './types.js';
import { sendWatchNotice } from './notify.js';
import { addedLines, hashLines, normalizedLines } from './page-diff.js';
import { extractPrice } from './price.js';
import { inStockOf } from './restock.js';
import { siteName } from './view.js';

export interface CheckDeps extends WatchDeps {
  now: Date;
}

interface WatchAlert {
  text: string;
  dedupeKey: string;
}

interface ReadResult {
  last: WatchLast;
  summary: string;
  alert?: WatchAlert;
}

export type CheckResult =
  | { status: 'ok'; watch: Watch; summary: string; alert: string | undefined }
  | { status: 'failed'; watch: Watch; summary: string }
  | { status: 'skipped'; watch: Watch; summary: string };

class CheckFailure extends Error {
  constructor(readonly summary: string) {
    super('watch check failed');
    this.name = 'CheckFailure';
  }
}

function missingCapability(deps: CheckDeps, watch: Watch): boolean {
  if (watch.kind === 'price' && watch.query !== undefined) {
    return deps.ctx.tryUse(Contracts.prices) === undefined;
  }
  return deps.ctx.tryUse(Contracts.webPage) === undefined;
}

function cheapest(offers: readonly PriceOffer[]): PriceOffer | undefined {
  let best: PriceOffer | undefined;
  for (const offer of offers) {
    if (!Number.isFinite(offer.priceKrw)) continue;
    if (best === undefined || offer.priceKrw < best.priceKrw) best = offer;
  }
  return best;
}

function nextAt(now: Date, minutes: number): string {
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

function backoffMinutes(everyMinutes: number, failures: number): number {
  return Math.min(everyMinutes * 2 ** Math.min(failures, 20), 24 * 60);
}

function canFillCart(deps: CheckDeps): boolean {
  try {
    return deps.ctx.tools.list().some((tool) => tool.name === 'errands.shop');
  } catch {
    return false;
  }
}

async function readPrice(deps: CheckDeps, watch: Watch): Promise<ReadResult> {
  let price: number;
  let mall: string;
  let offerUrl: string;

  if (watch.query !== undefined) {
    const prices = deps.ctx.tryUse(Contracts.prices);
    if (prices === undefined) throw new CheckFailure(deps.texts.capabilityMissing);
    const best = cheapest(await prices.lowest(watch.query, 5));
    if (best === undefined) throw new CheckFailure(deps.texts.checkNoPrice);
    price = best.priceKrw;
    mall = best.mall;
    offerUrl = best.url;
  } else if (watch.url !== undefined) {
    const web = deps.ctx.tryUse(Contracts.webPage);
    if (web === undefined) throw new CheckFailure(deps.texts.capabilityMissing);
    const page = await web.read(watch.url);
    const found = extractPrice(page.text, deps.currency);
    if (found === undefined) throw new CheckFailure(deps.texts.checkNoPrice);
    price = found;
    mall = siteName(watch.url);
    offerUrl = watch.url;
  } else {
    throw new CheckFailure(deps.texts.checkNoPrice);
  }

  const previous = watch.last?.price;
  const target = watch.targetPrice;
  const crossed = target !== undefined && price <= target && (previous === undefined || previous > target);
  const dropped = previous !== undefined && price * 100 <= previous * 95;
  const text = deps.texts.priceAlert(watch.label, previous, price, deps.currency, mall, offerUrl, watch.targetPrice);
  // a reached target can go straight to a cart when the errands skill is on (it stops at the cart, never pays)
  const offer = crossed && canFillCart(deps) ? `\n${deps.texts.cartOffer}` : '';
  const alert: WatchAlert | undefined = crossed || dropped ? { text: `${text}${offer}`, dedupeKey: `${watch.id}:${price}` } : undefined;

  return {
    last: { price, mall, offerUrl, checkedAt: deps.now.toISOString() },
    summary: deps.texts.checkPrice(price, deps.currency, mall),
    ...(alert !== undefined ? { alert } : {}),
  };
}

async function readRestock(deps: CheckDeps, watch: Watch): Promise<ReadResult> {
  const web = deps.ctx.tryUse(Contracts.webPage);
  if (web === undefined) throw new CheckFailure(deps.texts.capabilityMissing);
  if (watch.url === undefined) throw new CheckFailure(deps.texts.checkFailed);
  const page = await web.read(watch.url);
  const inStock = inStockOf(page.text);
  const previous = watch.last?.inStock;
  const alert: WatchAlert | undefined =
    previous === false && inStock
      ? {
          text: deps.texts.restockAlert(watch.label, siteName(watch.url), watch.url),
          dedupeKey: `${watch.id}:in-stock`,
        }
      : undefined;
  return {
    last: { inStock, checkedAt: deps.now.toISOString() },
    summary: inStock ? deps.texts.checkInStock : deps.texts.checkOutOfStock,
    ...(alert !== undefined ? { alert } : {}),
  };
}

async function readPage(deps: CheckDeps, watch: Watch): Promise<ReadResult> {
  const web = deps.ctx.tryUse(Contracts.webPage);
  if (web === undefined) throw new CheckFailure(deps.texts.capabilityMissing);
  if (watch.url === undefined) throw new CheckFailure(deps.texts.checkFailed);
  const page = await web.read(watch.url);
  const lines = normalizedLines(page.text);
  const hash = hashLines(lines);
  const previousHash = watch.last?.hash;
  const changed = previousHash !== undefined && previousHash !== hash;
  const added = changed ? addedLines(watch.last?.lines ?? [], lines) : [];
  const alert: WatchAlert | undefined = changed
    ? { text: deps.texts.pageAlert(watch.label, added, watch.url), dedupeKey: `${watch.id}:${hash}` }
    : undefined;
  const summary =
    previousHash === undefined
      ? deps.texts.checkBaseline
      : changed
        ? deps.texts.pageCheckChanged(added)
        : deps.texts.checkPageSame;
  return {
    last: { hash, lines: lines.slice(0, MAX_PAGE_LINES), checkedAt: deps.now.toISOString() },
    summary,
    ...(alert !== undefined ? { alert } : {}),
  };
}

function readWatch(deps: CheckDeps, watch: Watch): Promise<ReadResult> {
  switch (watch.kind) {
    case 'price':
      return readPrice(deps, watch);
    case 'restock':
      return readRestock(deps, watch);
    case 'page':
      return readPage(deps, watch);
  }
}

/** One check: updates the stored watch, notifies on the rules, and backs off on failure. */
export async function performCheck(deps: CheckDeps, watch: Watch): Promise<CheckResult> {
  if (missingCapability(deps, watch)) {
    return { status: 'skipped', watch, summary: deps.texts.capabilityMissing };
  }

  try {
    const result = await readWatch(deps, watch);
    const updated: Watch = {
      ...watch,
      failures: 0,
      nextAt: nextAt(deps.now, watch.everyMinutes),
      last: result.last,
    };
    await deps.store.update(updated);
    if (result.alert !== undefined) {
      await sendWatchNotice(deps.ctx, {
        kind: 'watch.alert',
        text: result.alert.text,
        dedupeKey: result.alert.dedupeKey,
      });
    }
    return { status: 'ok', watch: updated, summary: result.summary, alert: result.alert?.text };
  } catch (error) {
    const failures = watch.failures + 1;
    const updated: Watch = {
      ...watch,
      failures,
      nextAt: nextAt(deps.now, backoffMinutes(watch.everyMinutes, failures)),
    };
    await deps.store.update(updated);
    if (failures === 3) {
      await sendWatchNotice(deps.ctx, {
        kind: 'watch.failing',
        text: deps.texts.failing(watch.label),
        dedupeKey: `${watch.id}:failing`,
      });
    }
    if (!(error instanceof CheckFailure)) {
      deps.ctx.log.warn('watch: check failed', {
        id: watch.id,
        kind: watch.kind,
        error: error instanceof Error ? error.name : 'error',
      });
    }
    return {
      status: 'failed',
      watch: updated,
      summary: error instanceof CheckFailure ? error.summary : deps.texts.checkFailed,
    };
  }
}
