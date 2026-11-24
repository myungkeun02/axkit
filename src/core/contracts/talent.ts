/** A résumé the first look (or, later, a mail attachment) found, handed to the talent pack. */
export interface ResumeDoc {
  /** Stable id of the file (real path, Drive id…). */
  sourceId: string;
  /** "~/Documents/이력서/홍길동.pdf" or "Drive: …", for citations. */
  path: string;
  source: 'local' | 'drive' | 'mail';
  /** ISO 8601; a newer version of the same file is read again. */
  modifiedAt: string;
  /** Plain text of the file (stays on this computer; only a masked copy reaches a model). */
  text: string;
}

/** Capability "talent.intake", provided by the talent pack. */
export interface TalentIntake {
  /** False when this version of the file was already read. */
  wants(sourceId: string, modifiedAt: string): Promise<boolean>;
  /** Reads the résumé into the candidate list (one model request); never throws for a bad file. */
  add(doc: ResumeDoc): Promise<'added' | 'updated' | 'skipped'>;
}

export interface CareerStep {
  company: string;
  role?: string;
  /** "2019.03 – 2023.08" as written. */
  period?: string;
}

/** One person in the owner's candidate list. Kept on this computer only. */
export interface Candidate {
  id: string;
  name: string;
  /** "백엔드 개발자 · 8년" style one-liner. */
  headline: string;
  years?: number;
  roles: readonly string[];
  skills: readonly string[];
  career: readonly CareerStep[];
  education?: string;
  location?: string;
  /** What they want next (role, salary, remote), as written. */
  desired?: string;
  summary: string;
  /** Read from the file by code, never by a model. */
  contact: { email?: string; phone?: string };
  /** Every file this person was read from, newest first. */
  sources: readonly { path: string; modifiedAt: string }[];
  /** ISO 8601 of the newest source. */
  updatedAt: string;
}

export interface TalentQuery {
  /** Free words: skills, roles, companies, schools ("자바 결제 핀테크"). */
  text?: string;
  minYears?: number;
  maxYears?: number;
  /** Every one of these must be among the skills (case-insensitive, partial). */
  skills?: readonly string[];
  limit?: number;
}

/** Capability "talent.directory": the candidate list for search and matching. */
export interface TalentDirectory {
  search(query: TalentQuery): Promise<readonly { candidate: Candidate; score: number }[]>;
  get(id: string): Promise<Candidate | undefined>;
  count(): Promise<number>;
}
