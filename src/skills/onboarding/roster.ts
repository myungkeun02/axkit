import type { Activity } from './activity.js';
import type { CachedSummary } from './cache.js';

/** Everything the first look saw about one person, across documents, mail and calendar. */
export interface RosterEntry {
  name: string;
  emails: string[];
  titles: Map<string, number>;
  units: Map<string, number>;
  orgs: Map<string, number>;
  /** Units the documents say they lead. */
  leads: Set<string>;
  /** Documents naming them, and a few of their titles. */
  docs: number;
  sources: string[];
  /** Mails from them, and times they were on To/Cc. */
  mail: number;
  /** Calendar events they were invited to. */
  meetings: number;
  /** Their address shares a company domain with the owner's. */
  internal: boolean;
  signature?: string;
}

const PUBLIC_DOMAINS = /^(gmail|googlemail|naver|daum|hanmail|kakao|nate|hotmail|outlook|live|icloud|me|yahoo|proton|protonmail)\./i;
const MAX_SOURCES = 3;

function keyOf(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

function bump(map: Map<string, number>, value: string | undefined): void {
  if (value === undefined || value.trim() === '') return;
  map.set(value.trim(), (map.get(value.trim()) ?? 0) + 1);
}

/** "김민수 <ms@a.com>" → name and address; quotes and a bare address handled. */
export function splitAddress(value: string): { name?: string; email?: string } {
  const email = /<([^<>\s]+@[^<>\s]+)>/.exec(value)?.[1]?.toLowerCase() ?? (/^[^\s@<>]+@[^\s@<>]+$/.test(value.trim()) ? value.trim().toLowerCase() : undefined);
  const name = value.replace(/<[^>]*>/g, '').replace(/["']/g, '').trim();
  return { ...(name !== '' && !name.includes('@') ? { name } : {}), ...(email !== undefined ? { email } : {}) };
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1);
}

/** The most frequent value, ties by name. */
export function top(map: ReadonlyMap<string, number>): string | undefined {
  return [...map.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

/** How much the first look saw of someone: a person named once in passing ranks below a teammate. */
export function weight(entry: RosterEntry): number {
  return entry.docs * 3 + entry.mail + entry.meetings * 2 + (entry.internal ? 5 : 0) + (entry.units.size > 0 ? 4 : 0);
}

/** One entry per person: names in documents joined with mail senders, recipients and attendees by name or address. */
export function buildRoster(summaries: readonly CachedSummary[], activity: Activity | undefined): RosterEntry[] {
  const byName = new Map<string, RosterEntry>();
  const byEmail = new Map<string, RosterEntry>();
  const ownerDomains = new Set((activity?.ownerEmails ?? []).map(domainOf).filter((domain) => !PUBLIC_DOMAINS.test(domain)));
  const owner = new Set(activity?.ownerEmails ?? []);
  const entry = (name: string | undefined, email: string | undefined): RosterEntry | undefined => {
    if (email !== undefined && owner.has(email)) return undefined;
    const found = (email !== undefined ? byEmail.get(email) : undefined) ?? (name !== undefined ? byName.get(keyOf(name)) : undefined);
    if (found !== undefined) {
      if (email !== undefined && !found.emails.includes(email)) {
        found.emails.push(email);
        byEmail.set(email, found);
        found.internal ||= ownerDomains.has(domainOf(email));
      }
      if (name !== undefined && !byName.has(keyOf(name))) byName.set(keyOf(name), found);
      return found;
    }
    if (name === undefined || name.length < 2) return undefined;
    const fresh: RosterEntry = { name, emails: [], titles: new Map(), units: new Map(), orgs: new Map(), leads: new Set(), docs: 0, sources: [], mail: 0, meetings: 0, internal: false };
    byName.set(keyOf(name), fresh);
    if (email !== undefined) {
      fresh.emails.push(email);
      byEmail.set(email, fresh);
      fresh.internal = ownerDomains.has(domainOf(email));
    }
    return fresh;
  };

  // Mail first, so a document's "김민수" joins the sender who signs as 김민수.
  for (const mail of activity?.mails ?? []) {
    if (mail.sent) continue;
    const { name, email } = splitAddress(mail.from);
    const person = entry(name, email);
    if (person !== undefined) person.mail += 1;
  }
  for (const [value, count] of activity?.recipients ?? []) {
    const { name, email } = splitAddress(value);
    const person = entry(name, email);
    if (person !== undefined) person.mail += count;
  }
  for (const signature of activity?.signatures ?? []) {
    const { name, email } = splitAddress(signature.from);
    const person = entry(name, email);
    if (person !== undefined) person.signature ??= signature.text;
  }
  for (const event of activity?.events ?? []) {
    for (const attendee of event.attendees) {
      const email = splitAddress(attendee).email;
      const person = email === undefined ? undefined : byEmail.get(email);
      if (person !== undefined) person.meetings += 1;
    }
  }
  for (const summary of summaries) {
    for (const mention of summary.people ?? []) {
      const person = entry(mention.name, undefined);
      if (person === undefined) continue;
      person.docs += 1;
      if (person.sources.length < MAX_SOURCES && !person.sources.includes(summary.title)) person.sources.push(summary.title);
      bump(person.titles, mention.title);
      bump(person.units, mention.unit);
      bump(person.orgs, mention.org);
      if (mention.lead === true && mention.unit !== undefined) person.leads.add(mention.unit);
    }
  }
  return [...new Set(byName.values())].filter((person) => person.docs > 0 || person.mail >= 2 || person.meetings >= 2).sort((left, right) => weight(right) - weight(left) || left.name.localeCompare(right.name));
}
