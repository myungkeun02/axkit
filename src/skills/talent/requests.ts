import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { KeyValueStore } from '../../core/store/types.js';

const REQUESTS_KEY = 'requests';
const INTROS_KEY = 'intros';
const MAX_REQUESTS = 2_000;
const MAX_INTROS = 10_000;

export const REQUEST_STATUS = ['open', 'paused', 'filled', 'closed'] as const;
export const INTRO_STATUS = ['drafted', 'sent', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'] as const;

const RequestSchema = z.object({
  id: z.string(),
  company: z.string(),
  title: z.string(),
  skills: z.array(z.string()),
  minYears: z.number().optional(),
  maxYears: z.number().optional(),
  location: z.string().optional(),
  notes: z.string().optional(),
  /** Who asked, as a name or role ("인사팀 김OO"); never an address. */
  contact: z.string().optional(),
  status: z.enum(REQUEST_STATUS),
  /** "mail: 제목" or "chat". */
  source: z.string(),
  /** The mail it came from, to reply in the same thread. */
  mailId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const IntroSchema = z.object({
  id: z.string(),
  candidateId: z.string(),
  candidateName: z.string(),
  company: z.string(),
  requestId: z.string().optional(),
  status: z.enum(INTRO_STATUS),
  note: z.string().optional(),
  at: z.string(),
  updatedAt: z.string(),
});

export type HiringRequest = z.infer<typeof RequestSchema>;
export type Introduction = z.infer<typeof IntroSchema>;
export type RequestDraft = Omit<HiringRequest, 'id' | 'status' | 'createdAt' | 'updatedAt'>;

function norm(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '');
}

function shortId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 10)}`;
}

/** Hiring requests (positions a company asked the owner to fill) and every introduction made, on this computer only. */
export class TalentBook {
  private requests = new Map<string, HiringRequest>();
  private intros = new Map<string, Introduction>();

  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<void> {
    const requests = z.array(RequestSchema).safeParse(await this.kv.get<unknown>(REQUESTS_KEY));
    this.requests = new Map((requests.success ? requests.data : []).map((item) => [item.id, item]));
    const intros = z.array(IntroSchema).safeParse(await this.kv.get<unknown>(INTROS_KEY));
    this.intros = new Map((intros.success ? intros.data : []).map((item) => [item.id, item]));
  }

  /** The same company and title (or the same mail) is one request; a newer one updates its details. */
  async upsertRequest(draft: RequestDraft, now: Date): Promise<{ request: HiringRequest; created: boolean }> {
    const at = now.toISOString();
    const existing = [...this.requests.values()].find(
      (item) => (draft.mailId !== undefined && item.mailId === draft.mailId) || (norm(item.company) === norm(draft.company) && norm(item.title) === norm(draft.title) && item.status !== 'closed'),
    );
    const request: HiringRequest = {
      ...(existing ?? {}),
      ...draft,
      skills: [...new Set([...(existing?.skills ?? []), ...draft.skills])].slice(0, 20),
      id: existing?.id ?? shortId('r', draft.company, draft.title, at),
      status: existing?.status === 'paused' ? 'paused' : 'open',
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    this.requests.set(request.id, request);
    await this.saveRequests();
    return { request, created: existing === undefined };
  }

  async setRequestStatus(id: string, status: HiringRequest['status'], now: Date): Promise<HiringRequest | undefined> {
    const request = this.requests.get(id);
    if (request === undefined) return undefined;
    const next = { ...request, status, updatedAt: now.toISOString() };
    this.requests.set(id, next);
    await this.saveRequests();
    return next;
  }

  request(id: string): HiringRequest | undefined {
    return this.requests.get(id);
  }

  listRequests(filter: { status?: HiringRequest['status'] | 'active'; company?: string } = {}): HiringRequest[] {
    return [...this.requests.values()]
      .filter((item) => (filter.status === undefined ? true : filter.status === 'active' ? item.status === 'open' || item.status === 'paused' : item.status === filter.status))
      .filter((item) => filter.company === undefined || norm(item.company).includes(norm(filter.company)))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** Records an introduction; the same person to the same company for the same request is one record, updated. */
  async logIntro(input: Omit<Introduction, 'id' | 'at' | 'updatedAt'>, now: Date): Promise<Introduction> {
    const at = now.toISOString();
    const id = shortId('i', input.candidateId, norm(input.company), input.requestId ?? '');
    const existing = this.intros.get(id);
    const intro: Introduction = { ...input, id, at: existing?.at ?? at, updatedAt: at };
    this.intros.set(id, intro);
    await this.saveIntros();
    return intro;
  }

  async setIntroStatus(id: string, status: Introduction['status'], note: string | undefined, now: Date): Promise<Introduction | undefined> {
    const intro = this.intros.get(id);
    if (intro === undefined) return undefined;
    const next: Introduction = { ...intro, status, ...(note !== undefined ? { note } : {}), updatedAt: now.toISOString() };
    this.intros.set(id, next);
    await this.saveIntros();
    return next;
  }

  listIntros(filter: { candidateId?: string; company?: string; requestId?: string } = {}): Introduction[] {
    return [...this.intros.values()]
      .filter((item) => filter.candidateId === undefined || item.candidateId === filter.candidateId)
      .filter((item) => filter.company === undefined || norm(item.company) === norm(filter.company))
      .filter((item) => filter.requestId === undefined || item.requestId === filter.requestId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /** Already introduced to this company and not turned down or withdrawn: do not offer them again. */
  introducedTo(candidateId: string, company: string): Introduction | undefined {
    return this.listIntros({ candidateId, company }).find((item) => item.status !== 'rejected' && item.status !== 'withdrawn');
  }

  private async saveRequests(): Promise<void> {
    const list = [...this.requests.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, MAX_REQUESTS);
    this.requests = new Map(list.map((item) => [item.id, item]));
    await this.kv.set(REQUESTS_KEY, list);
  }

  private async saveIntros(): Promise<void> {
    const list = [...this.intros.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)).slice(0, MAX_INTROS);
    this.intros = new Map(list.map((item) => [item.id, item]));
    await this.kv.set(INTROS_KEY, list);
  }
}
