import type { MoneyCurrency } from './types.js';
import { MAX_WATCHES } from './types.js';

export type WatchLanguage = 'ko' | 'en';

function won(value: number): string {
  return `${Math.round(value).toLocaleString('ko-KR')}원`;
}

function usd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function money(value: number, currency: MoneyCurrency): string {
  return currency === 'KRW' ? won(value) : usd(value);
}

function quoteLines(lines: readonly string[]): string {
  return lines
    .slice(0, 3)
    .map((line) => `> ${line.length > 120 ? `${line.slice(0, 117)}…` : line}`)
    .join('\n');
}

export interface WatchTexts {
  readonly language: WatchLanguage;
  money(value: number, currency: MoneyCurrency): string;
  priceAlert(
    label: string,
    previous: number | undefined,
    price: number,
    currency: MoneyCurrency,
    mall: string,
    link: string,
    target: number | undefined,
  ): string;
  restockAlert(label: string, site: string, link: string): string;
  pageAlert(label: string, added: readonly string[], link: string): string;
  failing(label: string): string;
  /** Added to a reached target price when the errands skill can fill a cart (it never orders or pays). */
  readonly cartOffer: string;

  priceCondition(target: number | undefined, currency: MoneyCurrency): string;
  readonly restockCondition: string;
  readonly pageCondition: string;
  addDescription(label: string, condition: string): string;
  added(label: string, condition: string): string;

  listHeader(count: number): string;
  readonly listEmpty: string;
  watchLine(id: string, label: string, condition: string, last: string | null, nextCheck: string): string;
  removeDescription(label: string): string;
  removed(label: string): string;
  notFound(id: string): string;
  readonly limitReached: string;

  checkPrice(price: number, currency: MoneyCurrency, mall: string): string;
  readonly checkNoPrice: string;
  readonly checkInStock: string;
  readonly checkOutOfStock: string;
  readonly checkPageSame: string;
  readonly checkBaseline: string;
  pageCheckChanged(added: readonly string[]): string;
  readonly checkFailed: string;
  readonly capabilityMissing: string;

  lastPrice(price: number, currency: MoneyCurrency, mall: string): string;
  readonly lastInStock: string;
  readonly lastOutOfStock: string;
  readonly lastPageChecked: string;
}

const KO: WatchTexts = {
  language: 'ko',
  money,

  priceAlert(label, previous, price, currency, mall, link, target) {
    const lines: string[] = [];
    if (previous === undefined) lines.push(`🔔 「${label}」 지금 ${money(price, currency)} (${mall})`);
    else lines.push(`🔔 「${label}」 ${money(previous, currency)} → ${money(price, currency)} (${mall})`);
    if (target !== undefined && price <= target) lines.push(`목표가 ${money(target, currency)} 이하예요.`);
    lines.push(link);
    return lines.join('\n');
  },
  restockAlert: (label, site, link) => `🔔 「${label}」 다시 살 수 있게 됐어요.\n${site}\n${link}`,
  pageAlert(label, added, link) {
    const quote = quoteLines(added);
    return `🔔 「${label}」 페이지가 바뀌었어요.${quote === '' ? '' : `\n${quote}`}\n${link}`;
  },
  failing: (label) => `「${label}」 확인이 안 돼요. 잠시 뒤에 다시 해 볼게요.`,
  cartOffer: "장바구니에 담아 둘까요? '장바구니에 담아 줘'라고 하시면 담기까지만 하고 주문·결제는 직접 하시게 넘겨 드려요.",

  priceCondition: (target, currency) =>
    target === undefined ? '가격이 5% 넘게 내려가면' : `${money(target, currency)} 이하가 되면`,
  restockCondition: '재고가 생기면',
  pageCondition: '페이지가 바뀌면',
  addDescription: (label, condition) => `지켜보기 추가: 「${label}」 — ${condition}`,
  added: (label, condition) => `「${label}」 지켜보기 시작했어요. ${condition} 알려드릴게요.`,

  listHeader: (count) => `지켜보는 중 ${count}개`,
  listEmpty: '지켜보는 것이 없어요.',
  watchLine: (id, label, condition, last, nextCheck) =>
    `#${id} ${label} — ${condition}${last === null ? '' : ` · ${last}`} · 다음 ${nextCheck}`,
  removeDescription: (label) => `지켜보기 그만두기: ${label}`,
  removed: (label) => `「${label}」 지켜보기를 그만뒀어요.`,
  notFound: (id) => `#${id} 지켜보기를 찾지 못했어요.`,
  limitReached: `지켜보기는 ${MAX_WATCHES}개까지예요. 하나를 지우고 다시 해 주세요.`,

  checkPrice: (price, currency, mall) => `지금 ${money(price, currency)} (${mall})`,
  checkNoPrice: '가격을 찾지 못했어요.',
  checkInStock: '지금 살 수 있어요.',
  checkOutOfStock: '지금 품절이에요.',
  checkPageSame: '페이지가 그대로예요.',
  checkBaseline: '처음 상태를 기록했어요.',
  pageCheckChanged(added) {
    const quote = quoteLines(added);
    return quote === '' ? '페이지가 바뀌었어요.' : `페이지가 바뀌었어요.\n${quote}`;
  },
  checkFailed: '확인하지 못했어요.',
  capabilityMissing: '필요한 연결이 없어서 확인하지 못했어요.',

  lastPrice: (price, currency, mall) => `최근 ${money(price, currency)}${mall === '' ? '' : ` (${mall})`}`,
  lastInStock: '최근 재고 있음',
  lastOutOfStock: '최근 품절',
  lastPageChecked: '최근 확인함',
};

const EN: WatchTexts = {
  language: 'en',
  money,

  priceAlert(label, previous, price, currency, mall, link, target) {
    const lines: string[] = [];
    if (previous === undefined) lines.push(`🔔 "${label}" is ${money(price, currency)} now (${mall})`);
    else lines.push(`🔔 "${label}" ${money(previous, currency)} → ${money(price, currency)} (${mall})`);
    if (target !== undefined && price <= target) lines.push(`That is at or below your target of ${money(target, currency)}.`);
    lines.push(link);
    return lines.join('\n');
  },
  restockAlert: (label, site, link) => `🔔 "${label}" is available again.\n${site}\n${link}`,
  pageAlert(label, added, link) {
    const quote = quoteLines(added);
    return `🔔 "${label}" changed.${quote === '' ? '' : `\n${quote}`}\n${link}`;
  },
  failing: (label) => `I cannot check "${label}" right now. I will try again later.`,
  cartOffer: 'Want it in your cart? Say "put it in the cart" — I stop at the cart and leave ordering and payment to you.',

  priceCondition: (target, currency) =>
    target === undefined ? 'when the price drops 5% or more' : `when it is at or below ${money(target, currency)}`,
  restockCondition: 'when it is back in stock',
  pageCondition: 'when the page changes',
  addDescription: (label, condition) => `Add watch: "${label}" — ${condition}`,
  added: (label, condition) => `Watching "${label}". I will tell you ${condition}.`,

  listHeader: (count) => `Watching ${count}`,
  listEmpty: 'Nothing is being watched.',
  watchLine: (id, label, condition, last, nextCheck) =>
    `#${id} ${label} — ${condition}${last === null ? '' : ` · ${last}`} · next ${nextCheck}`,
  removeDescription: (label) => `Stop watching: ${label}`,
  removed: (label) => `Stopped watching "${label}".`,
  notFound: (id) => `No watch with id ${id}.`,
  limitReached: `Watches are limited to ${MAX_WATCHES}. Remove one and try again.`,

  checkPrice: (price, currency, mall) => `${money(price, currency)} now (${mall})`,
  checkNoPrice: 'Could not find a price.',
  checkInStock: 'It is available now.',
  checkOutOfStock: 'It is out of stock now.',
  checkPageSame: 'The page is unchanged.',
  checkBaseline: 'Recorded the first state.',
  pageCheckChanged(added) {
    const quote = quoteLines(added);
    return quote === '' ? 'The page changed.' : `The page changed.\n${quote}`;
  },
  checkFailed: 'Could not check it.',
  capabilityMissing: 'A required connection is missing, so it was not checked.',

  lastPrice: (price, currency, mall) => `last ${money(price, currency)}${mall === '' ? '' : ` (${mall})`}`,
  lastInStock: 'last in stock',
  lastOutOfStock: 'last out of stock',
  lastPageChecked: 'last checked',
};

export function watchTexts(language: string): WatchTexts {
  return language === 'en' ? EN : KO;
}
