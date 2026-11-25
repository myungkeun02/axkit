import { randomUUID } from 'node:crypto';
import type { PersonCommitment, PersonInteraction, PersonProfile, PersonSummary } from '../../core/contracts/memory.js';
import type { Clock } from '../../core/scheduler/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import { bareEmail, editDistance, personKey } from './people-keys.js';
import { CARD_FIELDS, PROFILE_LIMITS, fillFromScan, ownerSet } from './people-scan.js';

export interface StoredPerson {
  key: string;
  names: string[];
  emails: string[];
  interactions: PersonInteraction[];
  commitments: PersonCommitment[];
  profile?: PersonProfile;
  /** Card fields the first look wrote; the owner's own words replace them and a later scan may update them. */
  scanFields?: string[];
  updatedAt: string;
}

export interface PersonIdentity {
  name?: string;
  email?: string;
}

export interface CommitmentInput {
  direction: PersonCommitment['direction'];
  kind: PersonCommitment['kind'];
  text: string;
  due?: string;
}

const STORAGE_KEY = 'people';
const MAX_PERSONS = 500;
const MAX_INTERACTIONS = 30;
const MAX_COMMITMENTS = 30;
const MAX_ALIASES = 5;
const SUGGESTION_LIMIT = 3;

/** The card after `patch`: a new value replaces the field, an empty one keeps it; a new note line is added to the note. */
export function mergeProfile(current: PersonProfile | undefined, patch: PersonProfile): PersonProfile {
  const out: PersonProfile = { ...current };
  for (const field of ['title', 'company', 'team', 'relation'] as const) {
    const value = patch[field]?.trim();
    if (value !== undefined && value !== '') out[field] = value.slice(0, PROFILE_LIMITS[field]);
  }
  const note = patch.note?.trim();
  if (note !== undefined && note !== '') {
    const old = out.note ?? '';
    const joined = old === '' || note.includes(old) ? note : old.includes(note) ? old : `${old}\n${note}`;
    out.note = joined.length > PROFILE_LIMITS.note ? joined.slice(-PROFILE_LIMITS.note).replace(/^[^\n]*\n/, '') : joined;
  }
  return out;
}

function hasProfile(profile: PersonProfile | undefined): profile is PersonProfile {
  return profile !== undefined && Object.values(profile).some((value) => typeof value === 'string' && value !== '');
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStoredPerson(value: unknown): value is StoredPerson {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['key'] === 'string' &&
    isStringArray(record['names']) &&
    isStringArray(record['emails']) &&
    Array.isArray(record['interactions']) &&
    Array.isArray(record['commitments']) &&
    typeof record['updatedAt'] === 'string'
  );
}

function addAlias(list: string[], value: string): void {
  if (value.length === 0 || list.includes(value)) return;
  list.push(value);
  if (list.length > MAX_ALIASES) list.splice(0, list.length - MAX_ALIASES);
}

function toSummary(person: StoredPerson): PersonSummary {
  return {
    key: person.key,
    names: [...person.names],
    emails: [...person.emails],
    interactions: [...person.interactions],
    commitments: [...person.commitments],
    ...(hasProfile(person.profile) ? { profile: { ...person.profile } } : {}),
    updatedAt: person.updatedAt,
  };
}

/** What the assistant knows about the people in the owner's mail, calendar and notes. */
export class PeopleStore {
  private readonly people = new Map<string, StoredPerson>();

  constructor(
    private readonly kv: KeyValueStore,
    private readonly clock: Clock,
    private readonly language = 'ko',
  ) {}

  async load(): Promise<void> {
    const stored = await this.kv.get<unknown>(STORAGE_KEY);
    if (!Array.isArray(stored)) return;
    for (const person of stored.filter(isStoredPerson)) this.people.set(person.key, person);
  }

  all(): readonly StoredPerson[] {
    return [...this.people.values()];
  }

  get(key: string): StoredPerson | undefined {
    return this.people.get(key);
  }

  async find(nameOrEmail: string): Promise<PersonSummary | undefined> {
    const person = this.match(nameOrEmail);
    return person === undefined ? undefined : toSummary(person);
  }

  async openCommitments(): Promise<{ person: string; commitment: PersonCommitment }[]> {
    const open = this.all().flatMap((person) =>
      person.commitments
        .filter((commitment) => !commitment.done)
        .map((commitment) => ({ person: person.key, commitment })),
    );
    return open.sort((a, b) => (a.commitment.due ?? a.commitment.at).localeCompare(b.commitment.due ?? b.commitment.at));
  }

  /** People with a card, most recently updated first. */
  async cards(): Promise<PersonSummary[]> {
    return this.all()
      .filter((person) => hasProfile(person.profile))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(toSummary);
  }

  /** Fills a person's card (creating the person when new); see `mergeProfile`. */
  async setProfile(identity: PersonIdentity, patch: PersonProfile): Promise<StoredPerson> {
    const person = await this.ensure(identity);
    person.profile = mergeProfile(person.profile, patch);
    ownerSet(person, Object.keys(patch));
    person.updatedAt = this.clock.now().toISOString();
    await this.persist();
    return person;
  }

  /** What the first look read about a person; see `fillFromScan` in people-scan.ts. */
  async fillFromScan(identity: PersonIdentity, patch: PersonProfile): Promise<StoredPerson> {
    const person = await this.ensure(identity);
    if (fillFromScan(person, patch)) person.updatedAt = this.clock.now().toISOString();
    await this.persist();
    return person;
  }

  /** The owner's own fix from the app: each given field is set as is (an empty one clears it). */
  async editProfile(key: string, fields: { [K in keyof PersonProfile]?: string | undefined }): Promise<StoredPerson | undefined> {
    const person = this.people.get(key);
    if (person === undefined) return undefined;
    const next: PersonProfile = {};
    for (const field of CARD_FIELDS) {
      const value = (fields[field] ?? person.profile?.[field] ?? '').trim().slice(0, PROFILE_LIMITS[field]);
      if (value !== '') next[field] = value;
    }
    person.profile = next;
    ownerSet(person, Object.keys(fields).filter((field) => fields[field as keyof PersonProfile] !== undefined));
    person.updatedAt = this.clock.now().toISOString();
    await this.persist();
    return person;
  }

  /** Up to three keys close to the one asked for, for a "did you mean" answer. */
  suggestions(nameOrEmail: string): string[] {
    const target = personKey(nameOrEmail, this.language);
    if (target.length === 0) return [];
    const allowed = Math.max(2, Math.floor(target.length / 2));
    return this.all()
      .map((person) => ({
        key: person.key,
        distance: editDistance(target, person.key),
      }))
      .filter(
        (entry) =>
          entry.key !== target &&
          (entry.distance <= allowed || entry.key.includes(target) || target.includes(entry.key)),
      )
      .sort((a, b) => a.distance - b.distance || a.key.localeCompare(b.key))
      .slice(0, SUGGESTION_LIMIT)
      .map((entry) => entry.key);
  }

  async noteInteraction(identity: PersonIdentity, interaction: PersonInteraction): Promise<StoredPerson> {
    const person = await this.ensure(identity);
    person.interactions.push(interaction);
    if (person.interactions.length > MAX_INTERACTIONS) {
      person.interactions.splice(0, person.interactions.length - MAX_INTERACTIONS);
    }
    person.updatedAt = this.clock.now().toISOString();
    await this.persist();
    return person;
  }

  async addCommitment(identity: PersonIdentity, input: CommitmentInput): Promise<PersonCommitment> {
    const person = await this.ensure(identity);
    const at = this.clock.now().toISOString();
    const commitment: PersonCommitment = {
      id: randomUUID().slice(0, 8),
      direction: input.direction,
      kind: input.kind,
      text: input.text,
      at,
      done: false,
      ...(input.due !== undefined ? { due: input.due } : {}),
    };
    person.commitments.push(commitment);
    if (person.commitments.length > MAX_COMMITMENTS) {
      person.commitments.splice(0, person.commitments.length - MAX_COMMITMENTS);
    }
    person.updatedAt = at;
    await this.persist();
    return commitment;
  }

  async complete(name: string, commitmentId: string): Promise<PersonCommitment | undefined> {
    const person = this.match(name);
    const commitment = person?.commitments.find((candidate) => candidate.id === commitmentId);
    if (person === undefined || commitment === undefined) return undefined;
    commitment.done = true;
    person.updatedAt = this.clock.now().toISOString();
    await this.persist();
    return commitment;
  }

  private match(nameOrEmail: string): StoredPerson | undefined {
    const email = bareEmail(nameOrEmail);
    if (email !== undefined) {
      const byEmail = this.byEmail(email);
      if (byEmail !== undefined) return byEmail;
    }
    const key = personKey(nameOrEmail, this.language);
    const direct = this.people.get(key);
    if (direct !== undefined) return direct;
    return this.all().find((person) =>
      person.names.some((name) => personKey(name, this.language) === key),
    );
  }

  private byEmail(email: string): StoredPerson | undefined {
    return this.all().find((person) => person.emails.includes(email));
  }

  private async ensure(identity: PersonIdentity): Promise<StoredPerson> {
    const email = identity.email?.trim().toLowerCase();
    const name = identity.name?.trim();
    const key = name !== undefined && name.length > 0 ? personKey(name, this.language) : email;
    const existing =
      (email !== undefined && email.length > 0 ? this.byEmail(email) : undefined) ??
      (key !== undefined && key.length > 0 ? this.people.get(key) : undefined);
    if (existing !== undefined) {
      if (name !== undefined) addAlias(existing.names, name);
      if (email !== undefined) addAlias(existing.emails, email);
      return existing;
    }
    if (key === undefined || key.length === 0) throw new Error('A person needs a name or an email');
    const person: StoredPerson = {
      key,
      names: name !== undefined && name.length > 0 ? [name] : [],
      emails: email !== undefined && email.length > 0 ? [email] : [],
      interactions: [],
      commitments: [],
      updatedAt: this.clock.now().toISOString(),
    };
    this.people.set(key, person);
    this.prune();
    await this.persist();
    return person;
  }

  /** Over the cap, the person not touched for longest goes first. */
  private prune(): void {
    while (this.people.size > MAX_PERSONS) {
      const oldest = this.all().reduce((worst, person) => (person.updatedAt < worst.updatedAt ? person : worst));
      this.people.delete(oldest.key);
    }
  }

  private persist(): Promise<void> {
    return this.kv.set(STORAGE_KEY, [...this.people.values()]);
  }
}
