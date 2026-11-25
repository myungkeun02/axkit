import { z } from 'zod';

/** One person a document names, as the document writes it. Emails and phone numbers never get here (masked). */
export interface PersonMention {
  name: string;
  title?: string;
  /** Department or team ("마케팅팀"). */
  unit?: string;
  /** Company or organisation. */
  org?: string;
  /** They lead `unit`. */
  lead?: boolean;
}

export const MAX_MENTIONS = 150;

export const MentionSchema = z.object({
  name: z.string().min(1).max(40),
  title: z.string().max(40).optional(),
  unit: z.string().max(60).optional(),
  org: z.string().max(80).optional(),
  lead: z.boolean().optional(),
});

/** Names an org chart or member list uses for a slot, not a person. */
const NOT_A_NAME = /^(공석|미정|tbd|n\/a|담당자|팀장|대표|이사|부장|과장|대리|사원|직원|ceo|cto|cfo|담당|미상|홍길동|[^\p{L}]+)$/iu;
const HONORIFIC = /\s*(님|씨|선생님|대표님|팀장님|부장님|과장님|대리님)$/;

function clean(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, max);
  return text === '' ? undefined : text;
}

/** The model's list, with slot words, duplicates and stray fields dropped. */
export function cleanMentions(raw: unknown): PersonMention[] {
  if (!Array.isArray(raw)) return [];
  const out: PersonMention[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const name = clean(record.name, 40)?.replace(HONORIFIC, '').trim();
    if (name === undefined || name.length < 2 || NOT_A_NAME.test(name) || /\d{3,}|@/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const title = clean(record.title, 40);
    const unit = clean(record.unit, 60);
    const org = clean(record.org, 80);
    out.push({ name, ...(title !== undefined ? { title } : {}), ...(unit !== undefined ? { unit } : {}), ...(org !== undefined ? { org } : {}), ...(record.lead === true ? { lead: true } : {}) });
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}
