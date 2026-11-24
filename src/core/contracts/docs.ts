/**
 * Structured documents: team docs, decision records, change logs, company profile, the improvement log.
 * One store is the source of truth; anything rendered from it (a chat card, a markdown export) is a view.
 * Shapes follow the knowledge contract (`sources` are human-readable citations, times are ISO 8601).
 */

/** Who wrote a document or an entry. Only `user` stands for the owner's own words or approval. */
export type AuthorKind = 'user' | 'agent' | 'policy';

export interface DocAuthor {
  kind: AuthorKind;
  /** "owner", "lead:dev", "member:dev", "policy:wip-limit", "skill.tuning". */
  id: string;
}

export type DocKind = 'team' | 'decision' | 'changelog' | 'company' | 'improvement' | (string & {});

export interface DocEntry {
  /** ISO 8601. */
  at: string;
  /** One short paragraph; never a raw mail or chat body. */
  text: string;
  author: DocAuthor;
  sources: readonly string[];
}

export interface Doc {
  /** Stable, chosen by the writer: "company:team:dev", "company:decisions:dev", "tuning:improvements". */
  id: string;
  kind: DocKind;
  /** Grouping such as "company", "team:dev", "assistant". */
  scope: string;
  title: string;
  /** The current text. Entries are the dated history (decisions, changes) under it. */
  body: string;
  entries: readonly DocEntry[];
  /** Fact ids this document relies on; when one of them expires the document needs review. */
  basedOnFacts: readonly string[];
  needsReview: boolean;
  /** Why it needs review, for the owner ("사실 만료: 출시 전"). */
  reviewReason?: string;
  lastVerifiedAt?: string;
  updatedAt: string;
}

export interface DocInput {
  id: string;
  kind: DocKind;
  scope: string;
  title: string;
  body: string;
  author: DocAuthor;
  basedOnFacts?: readonly string[];
  sources?: readonly string[];
}

export interface DocQuery {
  kind?: DocKind;
  scope?: string;
  needsReview?: boolean;
}

/** Capability "knowledge.docs". */
export interface DocStore {
  get(id: string): Promise<Doc | undefined>;
  list(query?: DocQuery): Promise<Doc[]>;
  /** Creates or replaces the body; entries are kept. Replacing marks the doc verified. */
  upsert(input: DocInput): Promise<Doc>;
  /** Adds a dated entry; undefined when the doc does not exist. Old entries beyond the cap drop first. */
  append(id: string, entry: Omit<DocEntry, 'at'>): Promise<Doc | undefined>;
  /** The owner (or a check) confirmed the doc still matches reality. */
  verify(id: string): Promise<void>;
  /** Flags every doc based on this fact; resolves to the flagged ids. */
  flagFact(factId: string, reason: string): Promise<string[]>;
}
