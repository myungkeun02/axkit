/** Where a knowledge line came from. Lower ranks never replace a line the owner corrected. */
/** `file`: learned from a file the owner chose and approved; scans and memory never replace it. */
export type KnowledgeOrigin = 'scan' | 'memory' | 'file' | 'correction';

/**
 * "profile" lines describe the owner, "project" lines describe one project (topic = project name), anything else is a
 * topic area of remembered facts ("work", "people", ...).
 */
export type KnowledgeArea = 'profile' | 'project' | (string & {});

export interface KnowledgeLine {
  area: KnowledgeArea;
  /** Profile section ("role", "org", "interest"), project name, or the fact's topic. */
  topic: string;
  /** Stable name of what the line states inside its topic; a newer line with the same key replaces the old one. */
  key: string;
  text: string;
  /** Human-readable citations: "~/Documents/plan.md", "Drive: 사업계획", "mail: 견적 요청", "memory". */
  sources: readonly string[];
  /** ISO 8601. */
  at: string;
}

export interface StoredKnowledgeLine extends KnowledgeLine {
  /** Derived from area, topic and key. */
  id: string;
  origin: KnowledgeOrigin;
}

/** Capability "knowledge.profile": a short owner profile the assistant puts in every prompt. */
export interface ProfileReader {
  /** At most `maxChars` characters, or undefined before anything is known. */
  summary(maxChars: number): Promise<string | undefined>;
  /**
   * What the owner is asked to check, in card order: profile lines, then one line per project ("name: purpose").
   * Item ids are line ids, so a review answer can go straight to `KnowledgeWriter.correct`.
   */
  reviewLines(): Promise<readonly { id: string; text: string }[]>;
  /** Every project line now known (purpose, company, kind, remote…), for skills that act on the projects. */
  projectLines?(): Promise<readonly KnowledgeLine[]>;
}

export interface ScanResult {
  profile: readonly KnowledgeLine[];
  projects: readonly KnowledgeLine[];
}

/** Capability "knowledge.write". */
export interface KnowledgeWriter {
  /**
   * Replaces every scan-origin line with this set: lines no longer found are retired, corrected lines are kept.
   * Rebuilds the documents and resolves to how many lines were added or replaced and how many were retired.
   */
  replaceScan(result: ScanResult): Promise<{ added: number; retired: number }>;
  /** The owner's own fix of one line (by id); `text` undefined means the line is wrong and should go. */
  correct(id: string, text: string | undefined): Promise<void>;
}
