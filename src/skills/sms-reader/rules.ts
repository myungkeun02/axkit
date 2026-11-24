import { dateAndTime, findDates, quote } from './dates.js';
import type { BillFound, ParcelFound, ReservationFound, ReservationStatus, RuleResult } from './types.js';

/** Korean courier names as the parcel service knows them. */
const CARRIERS: readonly [RegExp, string][] = [
  [/CJ\s*대한통운|대한통운|CJ\s*택배/i, 'CJ대한통운'],
  [/한진\s*택배|한진/, '한진택배'],
  [/롯데\s*택배|롯데\s*글로벌\s*로지스/, '롯데택배'],
  [/우체국/, '우체국택배'],
  [/로젠/, '로젠택배'],
  [/경동\s*택배/, '경동택배'],
  [/대신\s*택배/, '대신택배'],
  [/일양\s*로지스/, '일양로지스'],
  [/합동\s*택배/, '합동택배'],
  [/CU\s*(편의점\s*택배|post)/i, 'CU 편의점택배'],
  [/GS\s*(postbox|편의점\s*택배)/i, 'GS Postbox 택배'],
];
const PARCEL_WORDS = /택배|배송|운송장|송장|등기|소포|집하|배달|출고/;
const LABELED_INVOICE = /(?:운송장|송장|등기|화물|invoice)\s*(?:번호|no\.?)?\s*[:：]?\s*(\d[\d-]{8,18}\d)/i;
const BARE_INVOICE = /(?<![\d-])(\d[\d-]{8,18}\d)(?![\d-])/g;
const PHONE_SHAPE = /^0\d{1,2}-\d{3,4}-\d{4}$|^1[5-9]\d{2}-\d{4}$/;

const BILL_WORDS = /청구|납부|납기|출금\s*예정|자동\s*이체|미납|고지서|관리비|공과금|요금|결제\s*예정|대금/;
const STRONG_BILL = /청구|납부|납기|출금\s*예정|자동\s*이체|미납|고지서|관리비|공과금/;
const APPROVAL = /승인|일시불|할부|사용\s*금액/;
const AMOUNT = /(\d{1,3}(?:,\d{3})+|\d+)\s*원/g;
const AMOUNT_LABEL = /(청구|납부|결제|이체|출금|금액|요금|대금|합계)/;
const DUE_LABEL = /(납부\s*기한|납기\s*일?|납부\s*일|마감|기한|까지|출금\s*(예정\s*)?일?|결제\s*(예정\s*)?일|이체\s*일)/;

const RESERVATION_WORDS = /예약|예매|booking|reservation/i;
const PLACE = /(?:장소|위치|지점|매장|극장|상영관|주소)\s*[:：]\s*([^\n]{2,40})/;
const SKIP_LABELS = /^(web\s*발신|국외\s*발신|국제\s*발신|광고|알림|안내|공지)$/i;
const LABEL = /[[【]\s*([^\]】\n]{2,20}?)\s*[\]】]/g;

/** The first "[예시치과]" label that names an organization, or a sender name that is not a number. */
export function orgOf(text: string, from: string | undefined): string | undefined {
  for (const match of text.matchAll(LABEL)) {
    const label = (match[1] ?? '').trim();
    if (label !== '' && !SKIP_LABELS.test(label)) return label;
  }
  const sender = (from ?? '').trim();
  return sender !== '' && !/^[+\d\s()#-]+$/.test(sender) ? sender.slice(0, 20) : undefined;
}

function digits(value: string): string {
  return value.replace(/-/g, '');
}

function invoiceOf(text: string): string | undefined {
  const labeled = LABELED_INVOICE.exec(text)?.[1];
  if (labeled !== undefined && digits(labeled).length >= 10 && digits(labeled).length <= 14) return digits(labeled);
  for (const match of text.matchAll(BARE_INVOICE)) {
    const raw = match[1] ?? '';
    const plain = digits(raw);
    if (PHONE_SHAPE.test(raw) || plain.length < 10 || plain.length > 14 || /^0\d{9,10}$/.test(plain)) continue;
    // an amount ("1,234,000원") is not an invoice; the bare pattern has no commas, so check what follows
    if (/^\s*원/.test(text.slice(match.index + raw.length))) continue;
    return plain;
  }
  return undefined;
}

export function parcelRule(text: string): ParcelFound | undefined {
  if (!PARCEL_WORDS.test(text)) return undefined;
  const carrier = CARRIERS.find(([pattern]) => pattern.test(text))?.[1];
  if (carrier === undefined) return undefined;
  const invoice = invoiceOf(text);
  return invoice === undefined ? undefined : { kind: 'parcel', carrier, invoice };
}

function amountOf(text: string): number | undefined {
  const all = [...text.matchAll(AMOUNT)];
  const labeled = all.find((match) => AMOUNT_LABEL.test(text.slice(Math.max(0, match.index - 15), match.index)));
  const chosen = labeled ?? all[0];
  if (chosen === undefined) return undefined;
  const value = Number((chosen[1] ?? '').replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function dueOf(text: string): { due: BillFound['due']; evidence: string } | undefined {
  const dates = findDates(text);
  const labeled = dates.find((date) => {
    const around = text.slice(Math.max(0, date.index - 20), Math.min(text.length, date.end + 8));
    return DUE_LABEL.test(around);
  });
  const chosen = labeled ?? (dates.length === 1 ? dates[0] : undefined);
  if (chosen === undefined) return undefined;
  return { due: chosen.value, evidence: quote(text, chosen.index, chosen.end) };
}

export function billRule(text: string, from: string | undefined): RuleResult {
  if (!BILL_WORDS.test(text)) return { status: 'none' };
  // "택시 요금 승인 8,000원" is a card approval for skill.spending, not a bill to pay
  if (APPROVAL.test(text) && !STRONG_BILL.test(text)) return { status: 'none' };
  const amount = amountOf(text);
  if (amount === undefined) return { status: 'unsure', hint: 'bill' };
  const payee = orgOf(text, from);
  const due = dueOf(text);
  const found: BillFound = {
    kind: 'bill',
    amount,
    ...(payee !== undefined ? { payee } : {}),
    ...(due?.due !== undefined ? { due: due.due, evidence: due.evidence } : {}),
  };
  return { status: 'sure', found };
}

function statusOf(text: string): ReservationStatus {
  if (/취소|cancel/i.test(text)) return 'cancelled';
  if (/변경|change/i.test(text)) return 'changed';
  return 'confirmed';
}

export function reservationRule(text: string, from: string | undefined): RuleResult {
  if (!RESERVATION_WORDS.test(text)) return { status: 'none' };
  const when = dateAndTime(text);
  if (when === undefined) return { status: 'unsure', hint: 'reservation' };
  const org = orgOf(text, from);
  const place = PLACE.exec(text)?.[1]?.trim();
  const found: ReservationFound = {
    kind: 'reservation',
    status: statusOf(text),
    date: when.date,
    evidence: when.evidence,
    ...(when.time !== undefined ? { time: when.time } : {}),
    ...(org !== undefined ? { org } : {}),
    ...(place !== undefined && place !== '' ? { place } : {}),
  };
  return { status: 'sure', found };
}


/**
 * Code rules first: a parcel needs a courier and a tracking number, a reservation a date the text states, a bill an
 * amount. A bill word beats a reservation word ("자동이체 예약"); a reservation beats a plain amount ("예매 12,000원").
 */
export function readByRules(text: string, from: string | undefined): RuleResult {
  const parcel = parcelRule(text);
  if (parcel !== undefined) return { status: 'sure', found: parcel };
  if (STRONG_BILL.test(text)) return billRule(text, from);
  const reservation = reservationRule(text, from);
  if (reservation.status !== 'none') return reservation;
  return billRule(text, from);
}
