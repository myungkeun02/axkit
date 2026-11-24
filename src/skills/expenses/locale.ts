import type { SpendCategory } from '../../core/contracts/index.js';
import type { RuleConfig } from './config.js';
import type { ClaimDecision } from './decisions.js';

export type ExpensesLanguage = 'ko' | 'en';

export interface ExpensesTexts {
  readonly language: ExpensesLanguage;
  readonly notConnected: string;
  readonly invalidRule: string;
  readonly ruleExists: string;
  readonly ruleLimit: string;
  readonly ruleFromConfig: string;
  readonly ruleMissing: string;
  readonly noRule: string;
  readonly unknownMerchant: string;
  readonly claimLabel: string;
  readonly personalLabel: string;
  readonly reviewChoice: string;
  readonly draftChoice: string;
  readonly sendChoice: string;
  readonly markClaimLabel: string;
  readonly markPersonalLabel: string;
  readonly claimGreeting: string;
  readonly subtotalTitle: string;
  readonly draftNote: string;
  readonly composerMissing: string;
  readonly noRecipientHint: string;
  readonly noCandidates: string;
  readonly notSent: string;
  readonly sent: string;
  readonly sendFailed: string;
  readonly mailNotConnected: string;
  readonly markFailed: string;
  readonly draftFailed: string;
  readonly totalPending: string;
  monthLabel(month: string): string;
  money(amount: number, currency: string): string;
  describeAddRule(rule: RuleConfig): string;
  describeRemoveRule(id: string): string;
  describeMark(entryId: string, decision: ClaimDecision): string;
  describeDraft(to: readonly string[], subject: string, total: string): string;
  claimSubject(companyLabel: string | undefined, month: string): string;
  claimLine(date: string, merchant: string, amount: string, rule: string): string;
  subtotalLine(name: string, count: number, amount: string): string;
  grandTotal(amount: string): string;
  capLine(name: string, cap: string, total: string): string;
  signature(name: string): string;
  monthlyTitle(month: string): string;
  monthlyRuleLine(name: string, count: number, total: string): string;
  monthlyTotal(total: string): string;
  monthlyUnsure(count: number): string;
  reviewTitle(month: string, candidates: number): string;
  reviewLine(date: string, merchant: string, amount: string, rule: string): string;
  reviewMore(count: number): string;
  noUnsure: string;
  markDone(decision: ClaimDecision): string;
  draftReply(subject: string, body: string, note: string): string;
}

const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const KO_CATEGORIES: Record<SpendCategory, string> = {
  food: '식비',
  cafe: '카페',
  groceries: '장보기',
  transport: '교통',
  shopping: '쇼핑',
  living: '생활',
  health: '의료',
  culture: '문화',
  travel: '여행',
  education: '교육',
  subscription: '구독',
  ai: 'AI',
  infra: '인프라',
  transfer: '이체',
  other: '기타',
};

const EN_CATEGORIES: Record<SpendCategory, string> = {
  food: 'food',
  cafe: 'cafe',
  groceries: 'groceries',
  transport: 'transport',
  shopping: 'shopping',
  living: 'living',
  health: 'health',
  culture: 'culture',
  travel: 'travel',
  education: 'education',
  subscription: 'subscription',
  ai: 'AI',
  infra: 'infra',
  transfer: 'transfer',
  other: 'other',
};

function categoryMap(language: ExpensesLanguage): Record<SpendCategory, string> {
  return language === 'ko' ? KO_CATEGORIES : EN_CATEGORIES;
}

function monthLabelOf(month: string, language: ExpensesLanguage): string {
  const [year, raw] = month.split('-');
  const index = Number(raw);
  if (language === 'ko') return `${year ?? month}년 ${Number.isFinite(index) ? index : raw}월`;
  return `${EN_MONTHS[index - 1] ?? month} ${year ?? ''}`.trim();
}

function moneyOf(amount: number, currency: string, language: ExpensesLanguage): string {
  const locale = language === 'ko' ? 'ko-KR' : 'en-US';
  if (currency === 'KRW') {
    const value = Math.round(amount).toLocaleString(locale);
    return language === 'ko' ? `${value}원` : `${value} KRW`;
  }
  const value = amount.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${currency} ${value}`;
}

function amountText(rule: RuleConfig, language: ExpensesLanguage): string | undefined {
  const locale = language === 'ko' ? 'ko-KR' : 'en-US';
  const round = (value: number): string => Math.round(value).toLocaleString(locale);
  if (rule.minAmount !== undefined && rule.maxAmount !== undefined) {
    return language === 'ko' ? `${round(rule.minAmount)}~${round(rule.maxAmount)}` : `${round(rule.minAmount)}-${round(rule.maxAmount)}`;
  }
  if (rule.minAmount !== undefined) return language === 'ko' ? `${round(rule.minAmount)} 이상` : `at least ${round(rule.minAmount)}`;
  if (rule.maxAmount !== undefined) return language === 'ko' ? `${round(rule.maxAmount)} 이하` : `up to ${round(rule.maxAmount)}`;
  return undefined;
}

function ruleDetail(rule: RuleConfig, language: ExpensesLanguage): string {
  const labels = categoryMap(language);
  const lines: string[] = [];
  if (rule.categories !== undefined) {
    lines.push(`${language === 'ko' ? '분류' : 'categories'}: ${rule.categories.map((id) => labels[id]).join(', ')}`);
  }
  if (rule.merchants !== undefined) {
    lines.push(`${language === 'ko' ? '가맹점' : 'merchants'}: ${rule.merchants.join(', ')}`);
  }
  if (rule.weekdaysOnly === true) lines.push(language === 'ko' ? '평일만' : 'weekdays only');
  if (rule.timeFrom !== undefined || rule.timeTo !== undefined) {
    const from = rule.timeFrom ?? '00:00';
    const to = rule.timeTo ?? '23:59';
    lines.push(`${language === 'ko' ? '시간' : 'time'}: ${from}–${to}`);
  }
  const amounts = amountText(rule, language);
  if (amounts !== undefined) lines.push(`${language === 'ko' ? '금액' : 'amount'}: ${amounts}`);
  if (rule.monthlyCap !== undefined) {
    const cap = Math.round(rule.monthlyCap).toLocaleString(language === 'ko' ? 'ko-KR' : 'en-US');
    lines.push(`${language === 'ko' ? '월 상한' : 'monthly cap'}: ${cap}`);
  }
  return [`${rule.name} (${rule.id})`, ...lines].join('\n');
}

const KO: ExpensesTexts = {
  language: 'ko',
  notConnected: '지출 내역이 연결되지 않았어요.',
  invalidRule: '규칙을 확인해 주세요. 시간 범위나 금액 범위가 잘못됐어요.',
  ruleExists: '같은 id의 규칙이 이미 있어요.',
  ruleLimit: '규칙은 30개까지 저장할 수 있어요.',
  ruleFromConfig: '설정 파일에서 지워 주세요.',
  ruleMissing: '그 규칙을 찾지 못했어요.',
  noRule: '직접 지정',
  unknownMerchant: '(가맹점 없음)',
  claimLabel: '청구',
  personalLabel: '개인',
  reviewChoice: '후보 확인',
  draftChoice: '청구 메일 초안',
  sendChoice: '보내기(승인 필요)',
  markClaimLabel: '청구',
  markPersonalLabel: '개인',
  claimGreeting: '안녕하세요. 아래는 지난달 경비 청구 내역이에요.',
  subtotalTitle: '규칙별 합계',
  draftNote: '아직 보내지 않았어요. 보내려면 승인이 필요해요.',
  composerMissing: '메일 초안 기능이 연결되지 않아서 본문만 만들어 두었어요. 복사해서 보내 주세요.',
  noRecipientHint: '청구 메일을 보낼 주소가 없어요. 설정에 claimTo를 넣거나 받는 사람을 알려 주세요.',
  noCandidates: '청구할 항목이 없어요.',
  notSent: '보내지 않았어요. 승인이 거절됐거나 시간이 지났어요.',
  sent: '청구 메일을 보냈어요.',
  sendFailed: '메일을 보내지 못했어요.',
  mailNotConnected: '메일 보내기가 연결되지 않았어요.',
  markFailed: '표시하지 못했어요.',
  draftFailed: '초안을 만들지 못했어요.',
  totalPending: '계산 전',
  monthLabel: (month) => monthLabelOf(month, 'ko'),
  money: (amount, currency) => moneyOf(amount, currency, 'ko'),
  describeAddRule: (rule) => `규칙 추가: ${ruleDetail(rule, 'ko')}`,
  describeRemoveRule: (id) => `규칙 삭제: ${id}`,
  describeMark: (entryId, decision) => `지출 표시: ${entryId} → ${decision === 'claim' ? '청구' : '개인'}`,
  describeDraft: (to, subject, total) =>
    `받는 사람: ${to.length > 0 ? to.join(', ') : '없음'}\n제목: ${subject}\n합계: ${total}`,
  claimSubject: (companyLabel, month) =>
    companyLabel !== undefined ? `${companyLabel} ${monthLabelOf(month, 'ko')} 경비 청구` : `${monthLabelOf(month, 'ko')} 경비 청구`,
  claimLine: (date, merchant, amount, rule) => `${date}  ${merchant}  ${amount}  ${rule}`,
  subtotalLine: (name, count, amount) => `- ${name}: ${count}건 ${amount}`,
  grandTotal: (amount) => `합계: ${amount}`,
  capLine: (name, cap, total) => `월 상한 초과: ${name} (상한 ${cap}, 합계 ${total})`,
  signature: (name) => `- ${name}`,
  monthlyTitle: (month) => `${monthLabelOf(month, 'ko')} 경비 청구 요약`,
  monthlyRuleLine: (name, count, total) => `- ${name}: ${count}건 ${total}`,
  monthlyTotal: (total) => `합계: ${total}`,
  monthlyUnsure: (count) => `확인 필요 ${count}건`,
  reviewTitle: (month, candidates) => `${monthLabelOf(month, 'ko')} 후보 확인\n청구 후보 ${candidates}건`,
  reviewLine: (date, merchant, amount, rule) => `${date}  ${merchant}  ${amount}  ${rule}`,
  reviewMore: (count) => `그 밖에 ${count}건 더 있어요.`,
  noUnsure: '확인할 항목이 없어요.',
  markDone: (decision) =>
    decision === 'claim'
      ? '청구로 표시했어요. 이 가맹점은 다음부터 청구 후보로 볼게요.'
      : '개인으로 표시했어요. 이 가맹점은 다음부터 빼 둘게요.',
  draftReply: (subject, body, note) => `제목: ${subject}\n\n${body}\n\n${note}`,
};

const EN: ExpensesTexts = {
  language: 'en',
  notConnected: 'Spending data is not connected.',
  invalidRule: 'Check the rule: the time or amount range is invalid.',
  ruleExists: 'A rule with that id already exists.',
  ruleLimit: 'At most 30 stored rules are allowed.',
  ruleFromConfig: 'Please remove it from the config file.',
  ruleMissing: 'That rule was not found.',
  noRule: 'Marked by you',
  unknownMerchant: '(no merchant)',
  claimLabel: 'claim',
  personalLabel: 'personal',
  reviewChoice: 'Review candidates',
  draftChoice: 'Draft claim mail',
  sendChoice: 'Send (needs approval)',
  markClaimLabel: 'Claim',
  markPersonalLabel: 'Personal',
  claimGreeting: "Hello. Here is last month's expense claim.",
  subtotalTitle: 'Totals by rule',
  draftNote: 'Nothing was sent yet. Sending needs your approval.',
  composerMissing: 'Mail drafting is not connected, so here is the text to copy.',
  noRecipientHint: 'No recipient for the claim mail. Set claimTo in the config or tell me an address.',
  noCandidates: 'Nothing to claim.',
  notSent: 'Not sent. The approval was denied or expired.',
  sent: 'The claim mail was sent.',
  sendFailed: 'Could not send the mail.',
  mailNotConnected: 'Mail sending is not connected.',
  markFailed: 'Could not mark it.',
  draftFailed: 'Could not write the draft.',
  totalPending: 'not calculated yet',
  monthLabel: (month) => monthLabelOf(month, 'en'),
  money: (amount, currency) => moneyOf(amount, currency, 'en'),
  describeAddRule: (rule) => `Add rule: ${ruleDetail(rule, 'en')}`,
  describeRemoveRule: (id) => `Remove rule: ${id}`,
  describeMark: (entryId, decision) => `Mark spend: ${entryId} → ${decision}`,
  describeDraft: (to, subject, total) =>
    `To: ${to.length > 0 ? to.join(', ') : 'none'}\nSubject: ${subject}\nTotal: ${total}`,
  claimSubject: (companyLabel, month) =>
    companyLabel !== undefined ? `${companyLabel} expense claim — ${monthLabelOf(month, 'en')}` : `Expense claim — ${monthLabelOf(month, 'en')}`,
  claimLine: (date, merchant, amount, rule) => `${date}  ${merchant}  ${amount}  ${rule}`,
  subtotalLine: (name, count, amount) => `- ${name}: ${count} item(s) ${amount}`,
  grandTotal: (amount) => `Total: ${amount}`,
  capLine: (name, cap, total) => `Over monthly cap: ${name} (cap ${cap}, total ${total})`,
  signature: (name) => `- ${name}`,
  monthlyTitle: (month) => `${monthLabelOf(month, 'en')} expense claim summary`,
  monthlyRuleLine: (name, count, total) => `- ${name}: ${count} item(s) ${total}`,
  monthlyTotal: (total) => `Total: ${total}`,
  monthlyUnsure: (count) => `${count} to review`,
  reviewTitle: (month, candidates) => `${monthLabelOf(month, 'en')} candidates\n${candidates} claim candidate(s)`,
  reviewLine: (date, merchant, amount, rule) => `${date}  ${merchant}  ${amount}  ${rule}`,
  reviewMore: (count) => `${count} more.`,
  noUnsure: 'Nothing to review.',
  markDone: (decision) =>
    decision === 'claim'
      ? 'Marked as claim. This merchant will be a claim candidate from now on.'
      : 'Marked as personal. This merchant will be left out from now on.',
  draftReply: (subject, body, note) => `Subject: ${subject}\n\n${body}\n\n${note}`,
};

export function expensesTexts(language: string): ExpensesTexts {
  return language === 'en' ? EN : KO;
}
