import type { Contact, ContactsReader } from '../../core/contracts/workspace.js';
import type { GoogleRequestFn } from './http.js';
import { isRecord } from './json.js';

const SEARCH = 'https://people.googleapis.com/v1/people:searchContacts';
const READ_MASK = 'names,emailAddresses,phoneNumbers,organizations';
const MAX_PAGE = 30;

function values(list: unknown, field: string): string[] {
  if (!Array.isArray(list)) return [];
  const found: string[] = [];
  for (const entry of list) {
    if (isRecord(entry) && typeof entry[field] === 'string' && entry[field] !== '') found.push(entry[field]);
  }
  return [...new Set(found)];
}

/** One People API person as a contact; a person with no name, email or phone is skipped. */
export function toContact(raw: unknown): Contact | undefined {
  if (!isRecord(raw)) return undefined;
  const person = isRecord(raw.person) ? raw.person : raw;
  const names = values(person.names, 'displayName');
  const emails = values(person.emailAddresses, 'value');
  const phones = values(person.phoneNumbers, 'value');
  const org = Array.isArray(person.organizations) ? person.organizations.find(isRecord) : undefined;
  const organization = org !== undefined && typeof org.name === 'string' && org.name !== '' ? org.name : undefined;
  const title = org !== undefined && typeof org.title === 'string' && org.title !== '' ? org.title : undefined;
  const name = names[0] ?? emails[0] ?? phones[0];
  if (name === undefined) return undefined;
  return {
    name,
    emails,
    phones,
    ...(organization !== undefined ? { organization } : {}),
    ...(title !== undefined ? { title } : {}),
  };
}

/**
 * Google Contacts search (People API, `contacts.readonly`). Google asks for one empty "warm-up" search before the
 * first real one so its search cache is fresh; it is sent once per run.
 */
export class GoogleContacts implements ContactsReader {
  private warmed = false;

  constructor(private readonly request: GoogleRequestFn) {}

  async search(query: string, limit: number, signal?: AbortSignal): Promise<Contact[]> {
    const text = query.trim();
    if (text === '' || limit <= 0) return [];
    if (!this.warmed) {
      await this.call('', 1, signal);
      this.warmed = true;
    }
    const payload = await this.call(text, Math.min(limit, MAX_PAGE), signal);
    const results = Array.isArray(payload.results) ? payload.results : [];
    const contacts: Contact[] = [];
    for (const raw of results) {
      const contact = toContact(raw);
      if (contact !== undefined) contacts.push(contact);
      if (contacts.length >= limit) break;
    }
    return contacts;
  }

  private async call(query: string, pageSize: number, signal: AbortSignal | undefined): Promise<{ results?: unknown }> {
    const url = new URL(SEARCH);
    url.searchParams.set('query', query);
    url.searchParams.set('readMask', READ_MASK);
    url.searchParams.set('pageSize', String(pageSize));
    return await this.request<{ results?: unknown }>(url.toString(), signal === undefined ? {} : { signal });
  }
}
