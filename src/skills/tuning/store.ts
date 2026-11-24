import type { CardFeedback, TuningChange } from '../../core/contracts/index.js';
import type { KeyValueStore } from '../../core/store/types.js';
import type {
  AppliedChange,
  MeasuredEffect,
  Proposal,
  ProposalReason,
  ProposalStatus,
  StoredFeedback,
  StoredVerdict,
} from './types.js';
import { isSpendCategory } from './types.js';

const FEEDBACK_KEY = 'feedback';
const PROPOSALS_KEY = 'proposals';
const APPLIED_KEY = 'applied';
const FEEDBACK_DAYS = 60;
const FEEDBACK_CAP = 2000;
const PROPOSAL_CAP = 500;
const APPLIED_CAP = 500;
const DAY_MS = 86_400_000;

const VERDICTS: ReadonlySet<string> = new Set<StoredVerdict>(['accepted', 'rejected', 'corrected']);
const STATUSES: ReadonlySet<string> = new Set<ProposalStatus>(['open', 'applied', 'declined']);
const ACTIONS: ReadonlySet<string> = new Set(['mute', 'unmute', 'set']);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isInstantOrUndefined(value: unknown): boolean {
  return value === undefined || isInstant(value);
}

function isChange(value: unknown): value is TuningChange {
  const item = record(value);
  return (
    item !== undefined &&
    typeof item['id'] === 'string' &&
    typeof item['domain'] === 'string' &&
    typeof item['subject'] === 'string' &&
    typeof item['action'] === 'string' &&
    ACTIONS.has(item['action']) &&
    (item['value'] === undefined || typeof item['value'] === 'string')
  );
}

function isNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isReason(value: unknown): value is ProposalReason {
  const item = record(value);
  if (item === undefined) return false;
  if (item['kind'] === 'notice' || item['kind'] === 'room') return isNumber(item['rejections']);
  if (item['kind'] === 'notice_volume') {
    return typeof item['noticeKind'] === 'string' && isNumber(item['perWeek']);
  }
  if (item['kind'] === 'feature_failures') {
    return (
      typeof item['feature'] === 'string' && isNumber(item['perWeek']) && typeof item['signature'] === 'string'
    );
  }
  if (item['kind'] === 'backlog') {
    return (
      isNumber(item['open']) &&
      isNumber(item['limit']) &&
      isNumber(item['autoClosed']) &&
      isNumber(item['created']) &&
      isNumber(item['done'])
    );
  }
  if (item['kind'] === 'no_effect') {
    return typeof item['of'] === 'string' && isNumber(item['baseline']) && isNumber(item['after']);
  }
  if (item['kind'] !== 'keyword') return false;
  return (
    typeof item['token'] === 'string' &&
    typeof item['category'] === 'string' &&
    isSpendCategory(item['category']) &&
    isNumber(item['count']) &&
    Array.isArray(item['subjects']) &&
    item['subjects'].every((subject) => typeof subject === 'string')
  );
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || isNumber(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isFeedback(value: unknown): value is StoredFeedback {
  const item = record(value);
  return (
    item !== undefined &&
    typeof item['domain'] === 'string' &&
    typeof item['subject'] === 'string' &&
    typeof item['verdict'] === 'string' &&
    VERDICTS.has(item['verdict']) &&
    isInstant(item['at']) &&
    (item['correction'] === undefined || typeof item['correction'] === 'string') &&
    (item['label'] === undefined || typeof item['label'] === 'string')
  );
}

function isProposal(value: unknown): value is Proposal {
  const item = record(value);
  return (
    item !== undefined &&
    typeof item['id'] === 'string' &&
    isChange(item['change']) &&
    isReason(item['reason']) &&
    isInstant(item['createdAt']) &&
    typeof item['status'] === 'string' &&
    STATUSES.has(item['status']) &&
    isOptionalString(item['metric']) &&
    isOptionalNumber(item['baseline'])
  );
}

function isMeasured(value: unknown): value is MeasuredEffect {
  const item = record(value);
  return (
    item !== undefined &&
    isNumber(item['afterPerWeek']) &&
    isInstant(item['at']) &&
    (item['effective'] === undefined || typeof item['effective'] === 'boolean')
  );
}

function isApplied(value: unknown): value is AppliedChange {
  const item = record(value);
  return (
    item !== undefined &&
    typeof item['id'] === 'string' &&
    isChange(item['change']) &&
    isInstant(item['appliedAt']) &&
    isNumber(item['baselinePerWeek']) &&
    isOptionalString(item['metric']) &&
    isOptionalNumber(item['baseline']) &&
    (item['measured'] === undefined || isMeasured(item['measured'])) &&
    isInstantOrUndefined(item['undoneAt'])
  );
}

function feedbackRecord(feedback: CardFeedback, fallback: Date): StoredFeedback {
  const at = feedback.at instanceof Date && Number.isFinite(feedback.at.getTime())
    ? feedback.at.toISOString()
    : fallback.toISOString();
  return {
    domain: feedback.domain,
    subject: feedback.subject,
    verdict: feedback.verdict,
    at,
    ...(feedback.correction !== undefined ? { correction: feedback.correction } : {}),
    ...(feedback.label !== undefined ? { label: feedback.label } : {}),
  };
}

/** Bounded feedback log, proposals and applied-change records in the plugin key-value store. */
export class TuningStore {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => Date,
  ) {}

  private async list<T>(key: string, guard: (value: unknown) => value is T): Promise<T[]> {
    const raw = await this.kv.get<unknown>(key);
    return Array.isArray(raw) ? raw.filter(guard) : [];
  }

  async append(feedback: CardFeedback): Promise<void> {
    const cutoff = this.now().getTime() - FEEDBACK_DAYS * DAY_MS;
    const kept = (await this.list(FEEDBACK_KEY, isFeedback))
      .filter((item) => Date.parse(item.at) >= cutoff)
      .slice(-(FEEDBACK_CAP - 1));
    kept.push(feedbackRecord(feedback, this.now()));
    await this.kv.set(FEEDBACK_KEY, kept);
  }

  async since(from: Date): Promise<StoredFeedback[]> {
    return (await this.list(FEEDBACK_KEY, isFeedback)).filter((item) => Date.parse(item.at) >= from.getTime());
  }

  async proposals(): Promise<Proposal[]> {
    return this.list(PROPOSALS_KEY, isProposal);
  }

  async proposal(id: string): Promise<Proposal | undefined> {
    return (await this.proposals()).find((item) => item.id === id);
  }

  async addProposals(items: readonly Proposal[]): Promise<void> {
    const existing = await this.proposals();
    const ids = new Set(existing.map((item) => item.id));
    const merged = [...existing, ...items.filter((item) => !ids.has(item.id))].slice(-PROPOSAL_CAP);
    await this.kv.set(PROPOSALS_KEY, merged);
  }

  async setProposalStatus(id: string, status: ProposalStatus): Promise<void> {
    const updated = (await this.proposals()).map((item) => (item.id === id ? { ...item, status } : item));
    await this.kv.set(PROPOSALS_KEY, updated);
  }

  async applied(): Promise<AppliedChange[]> {
    return this.list(APPLIED_KEY, isApplied);
  }

  async appliedById(id: string): Promise<AppliedChange | undefined> {
    return [...(await this.applied())].reverse().find((item) => item.id === id);
  }

  async addApplied(entry: AppliedChange): Promise<void> {
    const kept = (await this.applied()).filter((item) => item.id !== entry.id);
    kept.push(entry);
    await this.kv.set(APPLIED_KEY, kept.slice(-APPLIED_CAP));
  }

  async markMeasured(id: string, measured: MeasuredEffect): Promise<void> {
    const updated = (await this.applied()).map((item) => (item.id === id ? { ...item, measured } : item));
    await this.kv.set(APPLIED_KEY, updated);
  }

  async markUndone(id: string, at: string): Promise<void> {
    const updated = (await this.applied()).map((item) => (item.id === id ? { ...item, undoneAt: at } : item));
    await this.kv.set(APPLIED_KEY, updated);
  }
}
