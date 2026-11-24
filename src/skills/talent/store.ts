import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Candidate, TalentDirectory, TalentQuery } from '../../core/contracts/talent.js';
import type { KeyValueStore } from '../../core/store/types.js';
import type { Extracted } from './extract.js';

const CANDIDATES_KEY = 'candidates';
const SEEN_KEY = 'seen';
const MAX_SOURCES = 10;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const CandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  headline: z.string(),
  years: z.number().optional(),
  roles: z.array(z.string()),
  skills: z.array(z.string()),
  career: z.array(z.object({ company: z.string(), role: z.string().optional(), period: z.string().optional() })),
  education: z.string().optional(),
  location: z.string().optional(),
  desired: z.string().optional(),
  summary: z.string(),
  contact: z.object({ email: z.string().optional(), phone: z.string().optional() }),
  sources: z.array(z.object({ path: z.string(), modifiedAt: z.string() })),
  updatedAt: z.string(),
});

/** zod's optional fields are `T | undefined`; stored candidates never carry an explicit undefined. */
type Stored = Candidate;

function norm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

function idOf(name: string, key: string): string {
  return `c-${createHash('sha256').update(`${norm(name)}|${norm(key)}`).digest('hex').slice(0, 12)}`;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,./·|()[\]{}"'“”‘’:;!?]+/)
    .filter((word) => word.length >= 2);
}

function haystack(candidate: Candidate): string {
  return [candidate.name, candidate.headline, candidate.summary, candidate.desired ?? '', candidate.location ?? '', candidate.education ?? '', ...candidate.roles, ...candidate.skills, ...candidate.career.flatMap((step) => [step.company, step.role ?? ''])]
    .join(' ')
    .toLowerCase();
}

/** The candidate list: one JSON map in the pack's own store, on this computer only. */
export class TalentStore implements TalentDirectory {
  private candidates = new Map<string, Stored>();
  /** sourceId → modifiedAt of the version last read. */
  private seen: Record<string, string> = {};

  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<void> {
    const parsed = z.record(z.string(), CandidateSchema).safeParse(await this.kv.get<unknown>(CANDIDATES_KEY));
    this.candidates = new Map(parsed.success ? (Object.entries(parsed.data) as [string, Stored][]) : []);
    const seen = z.record(z.string(), z.string()).safeParse(await this.kv.get<unknown>(SEEN_KEY));
    this.seen = seen.success ? seen.data : {};
  }

  wants(sourceId: string, modifiedAt: string): boolean {
    return this.seen[sourceId] !== modifiedAt;
  }

  async markSeen(sourceId: string, modifiedAt: string): Promise<void> {
    this.seen[sourceId] = modifiedAt;
    await this.kv.set(SEEN_KEY, this.seen);
  }

  /**
   * The same person (same name and the same email, phone or first company) is one candidate: a newer file replaces
   * the fields, older files stay listed as sources.
   */
  async upsert(value: Extracted, contact: Candidate['contact'], source: { path: string; modifiedAt: string }): Promise<'added' | 'updated'> {
    const existing = [...this.candidates.values()].find(
      (candidate) =>
        norm(candidate.name) === norm(value.name) &&
        ((contact.email !== undefined && candidate.contact.email === contact.email) ||
          (contact.phone !== undefined && candidate.contact.phone === contact.phone) ||
          (candidate.sources.some((item) => item.path === source.path)) ||
          (value.career[0] !== undefined && candidate.career[0]?.company === value.career[0].company)),
    );
    const sources = [source, ...(existing?.sources.filter((item) => item.path !== source.path) ?? [])].sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt)).slice(0, MAX_SOURCES);
    const newer = existing === undefined || source.modifiedAt >= existing.updatedAt;
    const base: Stored = existing ?? {
      id: idOf(value.name, contact.email ?? contact.phone ?? value.career[0]?.company ?? source.path),
      name: value.name,
      headline: '',
      roles: [],
      skills: [],
      career: [],
      summary: '',
      contact: {},
      sources: [],
      updatedAt: source.modifiedAt,
    };
    const next: Stored = newer
      ? {
          id: base.id,
          ...value,
          contact: { ...base.contact, ...contact },
          sources,
          updatedAt: source.modifiedAt,
        }
      : { ...base, contact: { ...contact, ...base.contact }, sources, skills: [...new Set([...base.skills, ...value.skills])] };
    this.candidates.set(next.id, next);
    await this.kv.set(CANDIDATES_KEY, Object.fromEntries(this.candidates));
    return existing === undefined ? 'added' : 'updated';
  }

  async search(query: TalentQuery): Promise<{ candidate: Candidate; score: number }[]> {
    const terms = words(query.text ?? '');
    const skills = (query.skills ?? []).map((skill) => skill.toLowerCase());
    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
    const out: { candidate: Candidate; score: number }[] = [];
    for (const candidate of this.candidates.values()) {
      if (query.minYears !== undefined && (candidate.years === undefined || candidate.years < query.minYears)) continue;
      if (query.maxYears !== undefined && candidate.years !== undefined && candidate.years > query.maxYears) continue;
      const own = candidate.skills.map((skill) => skill.toLowerCase());
      if (!skills.every((skill) => own.some((item) => item.includes(skill) || skill.includes(item)))) continue;
      const text = haystack(candidate);
      let score = skills.length;
      for (const term of terms) {
        if (own.some((item) => item.includes(term))) score += 3;
        else if (candidate.roles.some((role) => role.toLowerCase().includes(term))) score += 2;
        else if (text.includes(term)) score += 1;
      }
      if (terms.length > 0 && score === skills.length) continue;
      out.push({ candidate, score });
    }
    return out.sort((left, right) => right.score - left.score || right.candidate.updatedAt.localeCompare(left.candidate.updatedAt)).slice(0, limit);
  }

  async get(id: string): Promise<Candidate | undefined> {
    return this.candidates.get(id);
  }

  async count(): Promise<number> {
    return this.candidates.size;
  }

  /** The skills seen most often, for the owner profile and the status tool. */
  topSkills(count: number): string[] {
    const tally = new Map<string, number>();
    for (const candidate of this.candidates.values()) for (const skill of candidate.skills) tally.set(skill, (tally.get(skill) ?? 0) + 1);
    return [...tally.entries()].sort((left, right) => right[1] - left[1]).slice(0, count).map(([skill]) => skill);
  }
}
