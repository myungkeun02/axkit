import { randomUUID } from 'node:crypto';
import type { Fact, FactSource, FactSourceKind, RecallQuery, RememberInput } from '../../core/contracts/memory.js';
import type { KeyValueStore } from '../../core/store/types.js';
import { normalizeText } from '../../core/time/evidence.js';
import { maskSecrets } from './mask.js';
import { tokenSet } from './tokens.js';
import { nearSame } from './facts-match.js';
import type { ReconcileChanges } from './reconcile-apply.js';
import { applyReconcile } from './reconcile-apply.js';

export interface StoredFact {
  id: string;
  subject: string;
  text: string;
  source: FactSource;
  learnedAt: string;
  confirmedAt: string;
  halfLifeDays: number;
  /** YYYY-MM-DD in the owner's zone: the last day the fact holds. */
  validUntil?: string;
  /** Event that ends the fact ("출시"). */
  untilEvent?: string;
  expiredAt?: string;
  /** "replaced": a newer fact about the same thing took its place (memory cleanup). */
  expiredReason?: 'date' | 'event' | 'replaced';
  /** The fact that replaced this one. */
  replacedBy?: string;
  /** A standing instruction or preference (상시 지시): always recalled, never fades. */
  standing?: true;
}

export { nearSame };

const STORAGE_KEY = 'facts';
const MAX_FACTS = 2000;
const MIN_STRENGTH = 0.05;
const DAY_MS = 86_400_000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_UNTIL_EVENT = 60;
/** Standing instructions go with every turn, up to this much text. */
const STANDING_CHARS = 1_000;
const STANDING_MAX = 10;

/** How long a fact takes to lose half its strength, by where it came from. */
export const HALF_LIFE_DAYS: Readonly<Record<FactSourceKind, number>> = {
  interview: 365,
  manual: 365,
  chat: 90,
  mail: 60,
  calendar: 60,
  phone: 60,
};

export function strengthOf(fact: Pick<StoredFact, 'confirmedAt' | 'halfLifeDays' | 'standing'>, now: Date): number {
  if (fact.standing === true) return 1;
  const confirmed = new Date(fact.confirmedAt).getTime();
  if (Number.isNaN(confirmed)) return 0;
  const ageDays = Math.max(0, (now.getTime() - confirmed) / DAY_MS);
  const halfLife = fact.halfLifeDays > 0 ? fact.halfLifeDays : HALF_LIFE_DAYS.chat;
  return Math.pow(0.5, ageDays / halfLife);
}

function sourceOf(source: FactSource): FactSource {
  return source.ref === undefined ? { kind: source.kind } : { kind: source.kind, ref: source.ref };
}

export function toFact(fact: StoredFact, now: Date): Fact {
  return {
    id: fact.id,
    subject: fact.subject,
    text: fact.text,
    source: sourceOf(fact.source),
    at: fact.confirmedAt,
    strength: strengthOf(fact, now),
    ...(fact.validUntil !== undefined ? { validUntil: fact.validUntil } : {}),
    ...(fact.untilEvent !== undefined ? { untilEvent: fact.untilEvent } : {}),
    ...(fact.expiredAt !== undefined ? { expired: true } : {}),
    ...(fact.standing === true ? { standing: true } : {}),
  };
}

function checkedValidUntil(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!YMD.test(value)) throw new Error('validUntil must be YYYY-MM-DD');
  return value;
}

/** An empty string clears the end event on re-confirm; undefined leaves it as it was. */
function checkedUntilEvent(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > MAX_UNTIL_EVENT) throw new Error('untilEvent is too long');
  return trimmed;
}

function normalizeSubject(subject: string): string {
  const trimmed = subject.trim();
  return trimmed.toLowerCase() === 'owner' ? 'owner' : trimmed.toLowerCase();
}

/** A malformed optional end condition is dropped; the fact itself is kept. */
function parseStoredFact(value: unknown): StoredFact | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record['id'] !== 'string' ||
    typeof record['subject'] !== 'string' ||
    typeof record['text'] !== 'string' ||
    typeof record['learnedAt'] !== 'string' ||
    typeof record['confirmedAt'] !== 'string' ||
    typeof record['halfLifeDays'] !== 'number' ||
    typeof record['source'] !== 'object' ||
    record['source'] === null
  ) {
    return undefined;
  }
  const fact: StoredFact = {
    id: record['id'],
    subject: record['subject'],
    text: record['text'],
    source: record['source'] as FactSource,
    learnedAt: record['learnedAt'],
    confirmedAt: record['confirmedAt'],
    halfLifeDays: record['halfLifeDays'],
  };
  const validUntil = record['validUntil'];
  if (typeof validUntil === 'string' && YMD.test(validUntil)) fact.validUntil = validUntil;
  const untilEvent = record['untilEvent'];
  if (typeof untilEvent === 'string') {
    const trimmed = untilEvent.trim();
    if (trimmed.length > 0 && trimmed.length <= MAX_UNTIL_EVENT) fact.untilEvent = trimmed;
  }
  const expiredAt = record['expiredAt'];
  if (typeof expiredAt === 'string' && Number.isFinite(Date.parse(expiredAt))) fact.expiredAt = expiredAt;
  const expiredReason = record['expiredReason'];
  if (expiredReason === 'date' || expiredReason === 'event' || expiredReason === 'replaced') fact.expiredReason = expiredReason;
  const replacedBy = record['replacedBy'];
  if (typeof replacedBy === 'string') fact.replacedBy = replacedBy;
  if (record['standing'] === true) fact.standing = true;
  return fact;
}


/** Facts in the plugin's key-value store. Repetition confirms a fact; silence lets it fade. */
export class FactStore {
  private facts: StoredFact[] = [];

  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => Date,
  ) {}

  async load(): Promise<void> {
    const stored = await this.kv.get<unknown>(STORAGE_KEY);
    this.facts = Array.isArray(stored)
      ? stored.map(parseStoredFact).filter((fact): fact is StoredFact => fact !== undefined)
      : [];
  }

  all(): readonly StoredFact[] {
    return this.facts;
  }

  get(id: string): StoredFact | undefined {
    return this.facts.find((fact) => fact.id === id);
  }

  /** Same subject and same normalized text confirms the old fact instead of adding a duplicate. */
  async remember(input: RememberInput): Promise<Fact> {
    const text = maskSecrets(input.text.trim());
    if (text.length === 0) throw new Error('Fact text is empty');
    const now = this.now();
    const iso = now.toISOString();
    const subject = normalizeSubject(input.subject);
    const ref = input.source.ref;
    const validUntil = checkedValidUntil(input.validUntil);
    const untilEvent = checkedUntilEvent(input.untilEvent);

    const next =
      input.source.kind === 'interview' && ref !== undefined
        ? this.facts.filter((fact) => !(fact.source.kind === 'interview' && fact.source.ref === ref))
        : [...this.facts];

    const wanted = normalizeText(text);
    // the same thing said a little differently ("오전엔 통화 어려움" / "오전에는 통화가 어려움") is one fact, worded the newer way
    const wantedTokens = tokenSet(text);
    const existing =
      next.find((fact) => fact.subject === subject && normalizeText(fact.text) === wanted) ??
      next.find((fact) => fact.subject === subject && fact.expiredAt === undefined && nearSame(tokenSet(fact.text), wantedTokens));
    if (existing !== undefined && normalizeText(existing.text) !== wanted && input.source.kind !== 'interview') existing.text = text;
    let result: StoredFact;
    if (existing !== undefined) {
      existing.confirmedAt = iso;
      existing.source = sourceOf(input.source);
      existing.halfLifeDays = input.halfLifeDays ?? existing.halfLifeDays;
      // Confirming an ended fact means its old end no longer applies; otherwise the next sweep ends it again.
      if (existing.expiredAt !== undefined) {
        if (existing.expiredReason === 'event') delete existing.untilEvent;
        else delete existing.validUntil;
      }
      if (validUntil !== undefined) existing.validUntil = validUntil;
      if (untilEvent !== undefined) {
        if (untilEvent.length === 0) delete existing.untilEvent;
        else existing.untilEvent = untilEvent;
      }
      delete existing.expiredAt;
      delete existing.expiredReason;
      if (input.standing === true) existing.standing = true;
      else if (input.standing === false) delete existing.standing;
      result = existing;
    } else {
      result = {
        id: randomUUID().slice(0, 8),
        subject,
        text,
        source: sourceOf(input.source),
        learnedAt: iso,
        confirmedAt: iso,
        halfLifeDays: input.halfLifeDays ?? HALF_LIFE_DAYS[input.source.kind],
        ...(validUntil !== undefined ? { validUntil } : {}),
        ...(untilEvent !== undefined && untilEvent.length > 0 ? { untilEvent } : {}),
        ...(input.standing === true ? { standing: true as const } : {}),
      };
      next.push(result);
    }

    this.facts = next;
    this.prune(now);
    await this.persist();
    return toFact(result, now);
  }

  /**
   * Standing instructions first, whatever the words (newest first, capped by size), then up to `limit` facts that
   * share words with the query.
   */
  async recall(query: RecallQuery): Promise<Fact[]> {
    const now = this.now();
    const subject = query.subject === undefined ? undefined : normalizeSubject(query.subject);
    const queryTokens = query.text === undefined ? [] : [...tokenSet(query.text)];
    const live = this.facts.filter((fact) => fact.expiredAt === undefined).filter((fact) => subject === undefined || fact.subject === subject);
    const standing = this.standing(live);

    const candidates = live
      .filter((fact) => fact.standing !== true)
      .map((fact) => {
        const strength = strengthOf(fact, now);
        const tokens = tokenSet(fact.text);
        const overlap = queryTokens.filter((token) => tokens.has(token)).length;
        return { fact, strength, overlap };
      })
      .filter((entry) => entry.strength >= MIN_STRENGTH)
      .filter((entry) => queryTokens.length === 0 || entry.overlap > 0);

    candidates.sort((a, b) => {
      if (a.overlap !== b.overlap) return b.overlap - a.overlap;
      if (a.strength !== b.strength) return b.strength - a.strength;
      return b.fact.confirmedAt.localeCompare(a.fact.confirmedAt);
    });

    return [...standing, ...candidates.slice(0, Math.max(0, query.limit)).map((entry) => entry.fact)].map((fact) => toFact(fact, now));
  }

  private standing(facts: readonly StoredFact[]): StoredFact[] {
    const out: StoredFact[] = [];
    let size = 0;
    for (const fact of [...facts].filter((item) => item.standing === true).sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt))) {
      if (out.length >= STANDING_MAX || size + fact.text.length > STANDING_CHARS) break;
      out.push(fact);
      size += fact.text.length;
    }
    return out;
  }

  /** Marks facts whose last valid day is strictly before `todayYmd` (owner's zone). */
  expireDue(todayYmd: string): StoredFact[] {
    const expiredAt = this.now().toISOString();
    const expired: StoredFact[] = [];
    for (const fact of this.facts) {
      if (fact.expiredAt !== undefined || fact.validUntil === undefined) continue;
      if (fact.validUntil < todayYmd) {
        fact.expiredAt = expiredAt;
        fact.expiredReason = 'date';
        expired.push(fact);
      }
    }
    if (expired.length > 0) void this.persist();
    return expired;
  }

  /** Ends facts tied to an event, matching the event name loosely ("출시" ends "출시일"). */
  expireEvent(event: string): StoredFact[] {
    const wanted = normalizeText(event);
    if (wanted.length < 2) return [];
    const expiredAt = this.now().toISOString();
    const expired: StoredFact[] = [];
    for (const fact of this.facts) {
      if (fact.expiredAt !== undefined || fact.untilEvent === undefined) continue;
      const target = normalizeText(fact.untilEvent);
      if (target.length < 2) continue;
      if (target === wanted || target.includes(wanted) || wanted.includes(target)) {
        fact.expiredAt = expiredAt;
        fact.expiredReason = 'event';
        expired.push(fact);
      }
    }
    if (expired.length > 0) void this.persist();
    return expired;
  }

  /** Applies the nightly cleanup's verdict (see reconcile.ts), then saves. */
  async reconcile(changes: ReconcileChanges): Promise<{ merged: number; replaced: number }> {
    const { facts, merged, replaced } = applyReconcile(this.facts, changes, this.now().toISOString());
    this.facts = facts;
    if (merged + replaced > 0) await this.persist();
    return { merged, replaced };
  }

  expiredFacts(): StoredFact[] {
    return this.facts.filter((fact) => fact.expiredAt !== undefined);
  }

  async remove(id: string): Promise<StoredFact | undefined> {
    const index = this.facts.findIndex((fact) => fact.id === id);
    if (index < 0) return undefined;
    const [removed] = this.facts.splice(index, 1);
    await this.persist();
    return removed;
  }

  /** Over the cap, the weakest facts go first: they are the ones the owner stopped confirming. */
  private prune(now: Date): void {
    while (this.facts.length > MAX_FACTS) {
      let weakest = 0;
      let weakestStrength = Number.POSITIVE_INFINITY;
      this.facts.forEach((fact, index) => {
        const strength = strengthOf(fact, now);
        if (strength < weakestStrength) {
          weakest = index;
          weakestStrength = strength;
        }
      });
      this.facts.splice(weakest, 1);
    }
  }

  private persist(): Promise<void> {
    return this.kv.set(STORAGE_KEY, this.facts);
  }
}
