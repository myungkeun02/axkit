import type { PersonProfile } from '../../core/contracts/memory.js';
import type { StoredPerson } from './people-store.js';

export const PROFILE_LIMITS: Record<keyof PersonProfile, number> = { title: 40, company: 60, team: 60, relation: 80, note: 400 };
export const CARD_FIELDS = ['title', 'company', 'team', 'relation', 'note'] as const;

/** The owner set these fields (in chat or the app): no scan writes them again. */
export function ownerSet(person: StoredPerson, fields: readonly string[]): void {
  if (person.scanFields === undefined) return;
  person.scanFields = person.scanFields.filter((field) => !fields.includes(field));
  if (person.scanFields.length === 0) delete person.scanFields;
}

/**
 * What the first look read about a person goes into a field the owner never set: an empty one, or one an earlier scan
 * wrote. The owner's own words always win. True when something changed.
 */
export function fillFromScan(person: StoredPerson, patch: PersonProfile): boolean {
  const profile: PersonProfile = { ...person.profile };
  const scanned = new Set(person.scanFields ?? []);
  let changed = false;
  for (const field of CARD_FIELDS) {
    const value = patch[field]?.trim().slice(0, PROFILE_LIMITS[field]);
    if (value === undefined || value === '') continue;
    const current = profile[field];
    if (current !== undefined && current !== '' && !scanned.has(field)) continue;
    if (current === value) continue;
    profile[field] = value;
    scanned.add(field);
    changed = true;
  }
  if (!changed) return false;
  person.profile = profile;
  person.scanFields = [...scanned];
  return true;
}
