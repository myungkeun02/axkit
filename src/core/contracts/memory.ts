export type FactSourceKind = 'chat' | 'interview' | 'mail' | 'calendar' | 'phone' | 'manual';

export interface FactSource {
  kind: FactSourceKind;
  /** Message, mail or event id the fact came from, when there is one. */
  ref?: string;
}

/** Something the assistant learned. Old facts fade unless they are confirmed again. */
export interface Fact {
  id: string;
  /** "owner" or a person key from the people memory. */
  subject: string;
  text: string;
  source: FactSource;
  /** ISO 8601, when it was learned or last confirmed. */
  at: string;
  /** Current strength in (0, 1], after decay. */
  strength: number;
  /** YYYY-MM-DD in the owner's zone: the last day the fact holds ("이번 주까지"). */
  validUntil?: string;
  /** An event that ends the fact ("출시"): "출시 전이라 …" stops holding once it happens. */
  untilEvent?: string;
  /** Past `validUntil` or its event happened. Expired facts are not recalled; the owner is asked again. */
  expired?: boolean;
  /** A standing instruction or preference ("메일은 항상 존댓말로"): always recalled, never fades. */
  standing?: true;
}

export interface RememberInput {
  subject: string;
  text: string;
  source: FactSource;
  /** Days until the fact is half as strong. Preferences from the interview fade slower than chat remarks. */
  halfLifeDays?: number;
  /** A time-limited fact must say when it ends: a date, an event, or both. */
  validUntil?: string;
  untilEvent?: string;
  /** A standing instruction or preference: recalled with every turn whatever the words, until it is forgotten. */
  standing?: boolean;
}

export interface RecallQuery {
  text?: string;
  subject?: string;
  limit: number;
}

/** Capability "memory.read". */
export interface MemoryReader {
  recall(query: RecallQuery): Promise<Fact[]>;
}

/** Capability "memory.write". Same text for the same subject confirms the old fact instead of adding one. */
export interface MemoryWriter {
  remember(input: RememberInput): Promise<Fact>;
}

export interface PersonInteraction {
  at: string;
  channel: 'mail' | 'calendar' | 'chat' | 'phone';
  /** One short line, written by code or a model from the source; never the raw body. */
  summary: string;
  ref?: string;
}

export interface PersonCommitment {
  id: string;
  /** mine = the owner promised; theirs = the other person promised or asked. */
  direction: 'mine' | 'theirs';
  kind: 'promise' | 'request';
  text: string;
  at: string;
  due?: string;
  done: boolean;
}

/** Who a person is to the owner, as the owner described them (a person card). Every field is optional. */
export interface PersonProfile {
  /** Job or role: "대표", "PM". */
  title?: string;
  company?: string;
  /** What they are to the owner: "내가 일하는 회사 대표", "거래처 담당자". */
  relation?: string;
  /** A few short lines on what they are like or care about. */
  note?: string;
}

export interface PersonSummary {
  key: string;
  names: readonly string[];
  emails: readonly string[];
  interactions: readonly PersonInteraction[];
  commitments: readonly PersonCommitment[];
  profile?: PersonProfile;
  updatedAt?: string;
}

/** Capability "people.read". `find` accepts a name with honorifics ("민수님") or an email. */
export interface PeopleReader {
  find(nameOrEmail: string): Promise<PersonSummary | undefined>;
  openCommitments(): Promise<{ person: string; commitment: PersonCommitment }[]>;
  /** People with a card (the owner described them), most recently updated first. */
  cards?(): Promise<PersonSummary[]>;
}

/** Capability "people.write": records that the owner talked with someone. Code-written one-liners only. */
export interface PeopleWriter {
  noteInteraction(identity: { name?: string; email?: string }, interaction: PersonInteraction): Promise<void>;
  /** Fills a person's card from what the owner said; empty fields keep what is there. Creates the person if new. */
  setProfile?(identity: { name?: string; email?: string }, profile: PersonProfile): Promise<void>;
}

/** Why a fact stopped holding. */
export interface FactExpired {
  id: string;
  subject: string;
  text: string;
  reason: 'date' | 'event';
}

/** Capability "memory.expiry": facts with an end condition. */
export interface MemoryExpiry {
  /** Expired facts not yet re-confirmed or removed by the owner. */
  expired(): Promise<Fact[]>;
  /** The owner said the event happened ("출시했어"); resolves to the facts it ended. */
  eventHappened(event: string): Promise<Fact[]>;
}

declare module '../events/types.js' {
  interface EventMap {
    /** Policies, settings and documents that relied on the fact listen to this and ask again. */
    'memory.fact_expired': FactExpired;
  }
}
