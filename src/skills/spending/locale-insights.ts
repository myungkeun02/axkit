import type { SpendingLanguage } from './locale.js';
import type { FlagReason } from './flags.js';
import type { TimeBand } from './patterns.js';
import type { Cadence } from './subscriptions.js';

export interface InsightTexts {
  readonly language: SpendingLanguage;
  monthLabel(ym: string): string;
  band(band: TimeBand): string;
  cadence(cadence: Cadence): string;
  flagReason(reason: FlagReason): string;

  reportTitle(month: string): string;
  reportTotal(money: string, changePercent: number | null): string;
  reportTopCategories(line: string): string;
  reportTopMerchants(line: string): string;
  reportCategoryChange(label: string, money: string, direction: 'up' | 'down' | 'new'): string;
  reportWeekendShare(percent: number): string;
  reportBandShare(band: TimeBand, percent: number): string;
  reportUnusual(date: string, merchant: string, money: string): string;
  reportFxCount(count: number): string;

  monthEndTitle(month: string): string;
  monthEndTotal(money: string): string;
  readonly monthEndChecksTitle: string;
  readonly monthEndNothing: string;
  monthEndLine(date: string, merchant: string, money: string, reason: FlagReason): string;
  readonly monthEndOkLabel: string;
  readonly monthEndMoreLabel: string;
  monthEndAck(month: string): string;
  monthEndMoreTitle(count: number): string;
  monthEndMoreLine(id: string, date: string, merchant: string, money: string, reason: FlagReason): string;
  readonly monthEndMoreHint: string;

  renewalLine(date: string, merchant: string, money: string, cadence: Cadence): string;
  readonly renewalKeepLabel: string;
  readonly renewalCancelLabel: string;
  renewalKept(merchant: string): string;
  readonly renewalGone: string;
  priceUpLine(merchant: string, oldMoney: string, newMoney: string): string;
  manageUrlLine(merchant: string, url: string): string;
  manageGeneric(merchant: string): string;
  readonly cancelNote: string;
}

const MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function percentText(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

const KO_BANDS: Record<TimeBand, string> = {
  morning: '아침(11시 전)',
  lunch: '점심(11–14시)',
  afternoon: '오후(14–18시)',
  evening: '저녁(18–22시)',
  night: '밤(22시 이후)',
};

const EN_BANDS: Record<TimeBand, string> = {
  morning: 'morning (before 11)',
  lunch: 'lunch (11–14)',
  afternoon: 'afternoon (14–18)',
  evening: 'evening (18–22)',
  night: 'night (after 22)',
};

const KO_REASONS: Record<FlagReason, string> = {
  unclassified: '분류 없음',
  duplicate: '중복 결제일 수 있어요',
  unusual: '큰 지출',
  fx: '환율로 계산함',
};

const EN_REASONS: Record<FlagReason, string> = {
  unclassified: 'Uncategorized',
  duplicate: 'Possible duplicate charge',
  unusual: 'Large charge',
  fx: 'FX estimate',
};

const KO: InsightTexts = {
  language: 'ko',
  monthLabel: (ym) => `${Number(ym.slice(5, 7))}월`,
  band: (band) => KO_BANDS[band],
  cadence: (cadence) => (cadence === 'monthly' ? '매월' : '매년'),
  flagReason: (reason) => KO_REASONS[reason],

  reportTitle: (month) => `${month} 지출`,
  reportTotal: (money, change) => {
    if (change === null) return `총 ${money} · 비교할 지난달이 없어요`;
    if (change === 0) return `총 ${money} · 지난달과 같아요`;
    return `총 ${money} · 지난달보다 ${percentText(Math.abs(change))}% ${change > 0 ? '늘었어요' : '줄었어요'}`;
  },
  reportTopCategories: (line) => `많이 쓴 분류: ${line}`,
  reportTopMerchants: (line) => `많이 쓴 곳: ${line}`,
  reportCategoryChange: (label, money, direction) => {
    if (direction === 'new') return `${label}에 ${money} 새로 썼어요`;
    return `${label} ${money} ${direction === 'up' ? '늘었어요' : '줄었어요'}`;
  },
  reportWeekendShare: (percent) => `주말에 ${percentText(percent)}%를 썼어요`,
  reportBandShare: (band, percent) => `${KO_BANDS[band]}에 ${percentText(percent)}%를 썼어요`,
  reportUnusual: (date, merchant, money) => `큰 지출: ${date} ${merchant} ${money}`,
  reportFxCount: (count) => `환율로 계산한 지출 ${count}건`,

  monthEndTitle: (month) => `${month} 말일 확인`,
  monthEndTotal: (money) => `지금까지 ${money} 썼어요`,
  monthEndChecksTitle: '확인할 것',
  monthEndNothing: '확인할 것이 없어요.',
  monthEndLine: (date, merchant, money, reason) =>
    `- ${date} ${merchant} ${money} — ${KO_REASONS[reason]}`,
  monthEndOkLabel: '확인했어요',
  monthEndMoreLabel: '전체 보기',
  monthEndAck: (month) => `${month} 지출을 확인한 것으로 표시했어요.`,
  monthEndMoreTitle: (count) => `확인할 지출 ${count}건`,
  monthEndMoreLine: (id, date, merchant, money, reason) =>
    `- ${id} · ${date} ${merchant} ${money} — ${KO_REASONS[reason]}`,
  monthEndMoreHint: '분류를 바꾸거나 지출에서 제외하려면 이 id를 말해 주세요.',

  renewalLine: (date, merchant, money, cadence) =>
    `${date} 갱신 예정: ${merchant} ${money} (${cadence === 'monthly' ? '매월' : '매년'})`,
  renewalKeepLabel: '계속 쓸게요',
  renewalCancelLabel: '해지 방법',
  renewalKept: (merchant) => `${merchant} 갱신 알림은 다음 주기까지 보내지 않을게요.`,
  renewalGone: '이미 지난 알림이에요.',
  priceUpLine: (merchant, oldMoney, newMoney) => `${merchant} 가격이 올랐어요: ${oldMoney} → ${newMoney}`,
  manageUrlLine: (merchant, url) => `${merchant} 해지는 ${url}에서 할 수 있어요.`,
  manageGeneric: (merchant) =>
    `${merchant} 해지는 카드사 앱의 정기결제 관리나 서비스 설정에서 할 수 있어요.`,
  cancelNote: '해지는 직접 해 주셔야 해요. 제가 대신 해지하지 않아요.',
};

const EN: InsightTexts = {
  language: 'en',
  monthLabel: (ym) => `${MONTHS_EN[Number(ym.slice(5, 7)) - 1] ?? ym} ${ym.slice(0, 4)}`,
  band: (band) => EN_BANDS[band],
  cadence: (cadence) => (cadence === 'monthly' ? 'monthly' : 'yearly'),
  flagReason: (reason) => EN_REASONS[reason],

  reportTitle: (month) => `${month} spending`,
  reportTotal: (money, change) => {
    if (change === null) return `Total ${money} · nothing to compare with last month`;
    if (change === 0) return `Total ${money} · same as last month`;
    return `Total ${money} · ${percentText(Math.abs(change))}% ${change > 0 ? 'more' : 'less'} than last month`;
  },
  reportTopCategories: (line) => `Top categories: ${line}`,
  reportTopMerchants: (line) => `Top merchants: ${line}`,
  reportCategoryChange: (label, money, direction) => {
    if (direction === 'new') return `${label}: ${money} new this month`;
    return `${label} ${money} ${direction === 'up' ? 'more' : 'less'}`;
  },
  reportWeekendShare: (percent) => `${percentText(percent)}% of spending was on the weekend`,
  reportBandShare: (band, percent) => `${percentText(percent)}% of spending was in the ${EN_BANDS[band]}`,
  reportUnusual: (date, merchant, money) => `Large charge: ${date} ${merchant} ${money}`,
  reportFxCount: (count) => `${count} charge(s) converted from another currency`,

  monthEndTitle: (month) => `${month} month-end check`,
  monthEndTotal: (money) => `Spent so far: ${money}`,
  monthEndChecksTitle: 'To check',
  monthEndNothing: 'Nothing to check.',
  monthEndLine: (date, merchant, money, reason) => `- ${date} ${merchant} ${money} — ${EN_REASONS[reason]}`,
  monthEndOkLabel: 'Checked',
  monthEndMoreLabel: 'Show all',
  monthEndAck: (month) => `Marked ${month} spending as reviewed.`,
  monthEndMoreTitle: (count) => `${count} spending item(s) to check`,
  monthEndMoreLine: (id, date, merchant, money, reason) =>
    `- ${id} · ${date} ${merchant} ${money} — ${EN_REASONS[reason]}`,
  monthEndMoreHint: 'Mention this id to change its category or exclude it.',

  renewalLine: (date, merchant, money, cadence) =>
    `Renews ${date}: ${merchant} ${money} (${cadence === 'monthly' ? 'monthly' : 'yearly'})`,
  renewalKeepLabel: 'Keeping it',
  renewalCancelLabel: 'How to cancel',
  renewalKept: (merchant) => `I will not remind you about ${merchant} again until the next cycle.`,
  renewalGone: 'That reminder has already passed.',
  priceUpLine: (merchant, oldMoney, newMoney) => `${merchant} raised its price: ${oldMoney} → ${newMoney}`,
  manageUrlLine: (merchant, url) => `You can cancel ${merchant} at ${url}.`,
  manageGeneric: (merchant) =>
    `You can cancel ${merchant} from your card app's recurring payments or the service's settings.`,
  cancelNote: 'You need to cancel it yourself. I do not cancel it for you.',
};

export function insightTexts(language: string): InsightTexts {
  return language === 'en' ? EN : KO;
}
