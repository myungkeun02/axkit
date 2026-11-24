import type { KeyValueStore } from '../../core/store/types.js';

/** A site the owner uses, in their words ("admin.example.co.kr — 회사 내부 관리 툴"). */
export interface KnownSite {
  host: string;
  label: string;
  what: string;
  addedAt: string;
  lastUsed?: string;
}

/** How a goal was reached once, kept so the next time starts from it. */
export interface Procedure {
  id: string;
  goal: string;
  site?: string;
  how: string;
  uses: number;
  lastOk: string;
}

const MAX_SITES = 50;
const MAX_PROCEDURES = 100;

export function hostOf(text: string): string | undefined {
  const match = /(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]|$)/i.exec(text.trim());
  return match?.[1]?.toLowerCase();
}

/** Words of two letters or more, for matching a request to what was done before. */
export function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^0-9a-z가-힣.]+/).filter((word) => word.length >= 2));
}

export class WaysStore {
  constructor(private readonly kv: KeyValueStore) {}

  async sites(): Promise<KnownSite[]> {
    return (await this.kv.get<KnownSite[]>('sites')) ?? [];
  }

  async rememberSite(site: Omit<KnownSite, 'addedAt'>, now: Date): Promise<KnownSite> {
    const all = await this.sites();
    const previous = all.find((item) => item.host === site.host);
    const next: KnownSite = { ...previous, ...site, addedAt: previous?.addedAt ?? now.toISOString() };
    await this.kv.set('sites', [next, ...all.filter((item) => item.host !== site.host)].slice(0, MAX_SITES));
    return next;
  }

  async forgetSite(host: string): Promise<boolean> {
    const all = await this.sites();
    await this.kv.set('sites', all.filter((item) => item.host !== host));
    return all.some((item) => item.host === host);
  }

  async touchSite(host: string, now: Date): Promise<void> {
    const all = await this.sites();
    if (!all.some((item) => item.host === host)) return;
    await this.kv.set('sites', all.map((item) => (item.host === host ? { ...item, lastUsed: now.toISOString() } : item)));
  }

  async procedures(): Promise<Procedure[]> {
    return (await this.kv.get<Procedure[]>('procedures')) ?? [];
  }

  /** The same goal on the same site updates one entry instead of piling up. */
  async recordProcedure(input: { goal: string; site?: string; how: string }, now: Date): Promise<void> {
    const all = await this.procedures();
    const key = `${input.site ?? ''}|${input.goal.trim().toLowerCase()}`;
    const previous = all.find((item) => `${item.site ?? ''}|${item.goal.trim().toLowerCase()}` === key);
    const next: Procedure = {
      id: previous?.id ?? `p${now.getTime().toString(36)}`,
      goal: input.goal.trim().slice(0, 200),
      ...(input.site !== undefined ? { site: input.site } : {}),
      how: input.how.trim().slice(0, 400),
      uses: (previous?.uses ?? 0) + 1,
      lastOk: now.toISOString(),
    };
    await this.kv.set('procedures', [next, ...all.filter((item) => item !== previous)].slice(0, MAX_PROCEDURES));
  }

  /** Procedures that share the most words with the request (at least one). */
  async relevant(text: string, limit = 3): Promise<Procedure[]> {
    const asked = words(text);
    const scored = (await this.procedures())
      .map((item) => ({ item, score: [...words(`${item.goal} ${item.site ?? ''}`)].filter((word) => asked.has(word)).length }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.item.uses - a.item.uses);
    return scored.slice(0, limit).map((entry) => entry.item);
  }
}
