import type { TuningChange } from '../../core/contracts/index.js';
import { changeKey, withId } from './change.js';
import type { DetectedChange, ProposalReason, StoredFeedback } from './types.js';
import { isSpendCategory } from './types.js';

const DAY_MS = 86_400_000;
const NOTICE_WINDOW_DAYS = 14;
const ROOM_WINDOW_DAYS = 30;
const SPEND_WINDOW_DAYS = 30;
const MIN_NOTICE_REJECTIONS = 2;
const MIN_ROOM_REJECTIONS = 3;
const MIN_KEYWORD_SUBJECTS = 2;
const DEFAULT_LIMIT = 3;

const STOPWORDS: ReadonlySet<string> = new Set([
  'inc',
  'co',
  'ltd',
  'corp',
  'store',
  'shop',
  'the',
  '주식회사',
  '점',
  '지점',
  '본점',
]);

export interface DetectInput {
  feedback: readonly StoredFeedback[];
  now: Date;
  /** Changes already open, applied or declined. */
  existing: readonly TuningChange[];
  /** Defaults to 3. */
  limit?: number;
}

/** NFC, lowercase, letters and digits only; the form keyword rules are compared in. */
export function normalizeText(text: string): string {
  return text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Words in a merchant label that may name a whole class of merchants. */
export function tokensOf(label: string): string[] {
  const tokens = label.normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const result: string[] = [];
  for (const token of tokens) {
    if (token.length < 2 || /^\d+$/.test(token) || STOPWORDS.has(token)) continue;
    if (!result.includes(token)) result.push(token);
  }
  return result;
}

function within(item: StoredFeedback, now: Date, days: number): boolean {
  const age = now.getTime() - Date.parse(item.at);
  return age >= 0 && age <= days * DAY_MS;
}

interface Counts {
  rejected: number;
  accepted: number;
}

function verdictCounts(
  feedback: readonly StoredFeedback[],
  domain: string,
  now: Date,
  days: number,
): Map<string, Counts> {
  const groups = new Map<string, Counts>();
  for (const item of feedback) {
    if (item.domain !== domain || !within(item, now, days)) continue;
    if (item.verdict !== 'rejected' && item.verdict !== 'accepted') continue;
    const counts = groups.get(item.subject) ?? { rejected: 0, accepted: 0 };
    if (item.verdict === 'rejected') counts.rejected += 1;
    else counts.accepted += 1;
    groups.set(item.subject, counts);
  }
  return groups;
}

function rejectedChanges(
  feedback: readonly StoredFeedback[],
  now: Date,
  excluded: ReadonlySet<string>,
  domain: string,
  days: number,
  minimum: number,
  kind: 'notice' | 'room',
): DetectedChange[] {
  const found: DetectedChange[] = [];
  const groups = [...verdictCounts(feedback, domain, now, days).entries()].sort(
    ([leftSubject, left], [rightSubject, right]) =>
      right.rejected - left.rejected || leftSubject.localeCompare(rightSubject),
  );
  for (const [subject, counts] of groups) {
    if (counts.rejected < minimum || counts.accepted > 0) continue;
    const change = withId({ domain, subject, action: 'mute' });
    if (excluded.has(changeKey(change))) continue;
    const reason: ProposalReason = { kind, rejections: counts.rejected };
    found.push({ id: change.id, change, reason });
  }
  return found;
}

interface KeywordStat {
  subjects: Set<string>;
  categories: Set<string>;
}

function spendChanges(
  feedback: readonly StoredFeedback[],
  now: Date,
  excluded: ReadonlySet<string>,
): DetectedChange[] {
  const stats = new Map<string, KeywordStat>();
  for (const item of feedback) {
    if (item.domain !== 'spend.category' || item.verdict !== 'corrected') continue;
    if (!within(item, now, SPEND_WINDOW_DAYS)) continue;
    if (item.correction === undefined || !isSpendCategory(item.correction) || item.label === undefined) continue;
    for (const token of tokensOf(item.label)) {
      const stat = stats.get(token) ?? { subjects: new Set<string>(), categories: new Set<string>() };
      stat.subjects.add(item.subject);
      stat.categories.add(item.correction);
      stats.set(token, stat);
    }
  }

  const found: DetectedChange[] = [];
  const ordered = [...stats.entries()].sort(
    ([leftToken, left], [rightToken, right]) =>
      right.subjects.size - left.subjects.size || leftToken.localeCompare(rightToken),
  );
  for (const [token, stat] of ordered) {
    if (stat.subjects.size < MIN_KEYWORD_SUBJECTS || stat.categories.size !== 1) continue;
    const category = [...stat.categories][0];
    if (category === undefined || !isSpendCategory(category)) continue;
    const change = withId({ domain: 'spend.category', subject: token, action: 'set', value: category });
    if (excluded.has(changeKey(change))) continue;
    const reason: ProposalReason = {
      kind: 'keyword',
      token,
      category,
      subjects: [...stat.subjects].sort(),
      count: stat.subjects.size,
    };
    found.push({ id: change.id, change, reason });
  }
  return found;
}

/** Deterministic weekly proposals from the last 30 days of feedback. */
export function detectChanges(input: DetectInput): DetectedChange[] {
  const excluded = new Set(input.existing.map(changeKey));
  const limit = Math.max(0, input.limit ?? DEFAULT_LIMIT);
  const found = [
    ...rejectedChanges(input.feedback, input.now, excluded, 'notice', NOTICE_WINDOW_DAYS, MIN_NOTICE_REJECTIONS, 'notice'),
    ...rejectedChanges(
      input.feedback,
      input.now,
      excluded,
      'chat.appointment',
      ROOM_WINDOW_DAYS,
      MIN_ROOM_REJECTIONS,
      'room',
    ),
    ...spendChanges(input.feedback, input.now, excluded),
  ];
  return found.slice(0, limit);
}
