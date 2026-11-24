import type { WatchTexts } from './locale.js';
import type { MoneyCurrency, Watch } from './types.js';

const formatters = new Map<string, Intl.DateTimeFormat>();

/** "YYYY-MM-DD HH:MM" in the owner zone. */
export function formatWhen(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.year ?? ''}-${parts.month ?? ''}-${parts.day ?? ''} ${parts.hour ?? ''}:${parts.minute ?? ''}`;
}

export function siteName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

export function conditionOf(
  watch: Pick<Watch, 'kind' | 'targetPrice'>,
  texts: WatchTexts,
  currency: MoneyCurrency,
): string {
  switch (watch.kind) {
    case 'price':
      return texts.priceCondition(watch.targetPrice, currency);
    case 'restock':
      return texts.restockCondition;
    case 'page':
      return texts.pageCondition;
  }
}

function lastOf(watch: Watch, texts: WatchTexts, currency: MoneyCurrency): string | null {
  const last = watch.last;
  if (last === undefined) return null;
  if (watch.kind === 'price' && last.price !== undefined) {
    return texts.lastPrice(last.price, currency, last.mall ?? '');
  }
  if (watch.kind === 'restock' && last.inStock !== undefined) {
    return last.inStock ? texts.lastInStock : texts.lastOutOfStock;
  }
  if (watch.kind === 'page') return texts.lastPageChecked;
  return null;
}

export interface WatchView {
  id: string;
  kind: Watch['kind'];
  label: string;
  condition: string;
  last: string | null;
  lastCheckedAt: string | null;
  nextCheck: string;
}

export interface ViewOptions {
  texts: WatchTexts;
  currency: MoneyCurrency;
  timeZone: string;
}

export function watchView(watch: Watch, options: ViewOptions): WatchView {
  return {
    id: watch.id,
    kind: watch.kind,
    label: watch.label,
    condition: conditionOf(watch, options.texts, options.currency),
    last: lastOf(watch, options.texts, options.currency),
    lastCheckedAt: watch.last === undefined ? null : formatWhen(watch.last.checkedAt, options.timeZone),
    nextCheck: formatWhen(watch.nextAt, options.timeZone),
  };
}
