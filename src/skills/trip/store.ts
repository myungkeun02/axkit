import type { KeyValueStore } from '../../core/store/types.js';
import type { TripSegment } from './types.js';
import { SEGMENT_KINDS } from './types.js';

const SEGMENTS_KEY = 'segments';
const SEEN_KEY = 'seen';
const MAX_SEGMENTS = 300;
const MAX_SEEN = 3_000;

function isSegment(value: unknown): value is TripSegment {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    typeof record['mailId'] === 'string' &&
    typeof record['kind'] === 'string' &&
    (SEGMENT_KINDS as readonly string[]).includes(record['kind']) &&
    typeof record['title'] === 'string' &&
    typeof record['start'] === 'string' &&
    typeof record['startText'] === 'string'
  );
}

function normalizeReference(value: string): string {
  return value.trim().toLowerCase();
}

function sameBooking(left: TripSegment, right: TripSegment): boolean {
  if (left.kind !== right.kind || left.start !== right.start) return false;
  if (left.reference !== undefined && right.reference !== undefined) {
    return normalizeReference(left.reference) === normalizeReference(right.reference);
  }
  return left.title === right.title;
}

/** Bounded key-value repository for booking segments and already-scanned mail ids. */
export class TripStore {
  private items: TripSegment[] = [];
  private seen: string[] = [];
  private seenIds = new Set<string>();

  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<void> {
    const stored = await this.kv.get<unknown>(SEGMENTS_KEY);
    this.items = Array.isArray(stored) ? stored.filter(isSegment) : [];
    const seen = await this.kv.get<unknown>(SEEN_KEY);
    const list = Array.isArray(seen) ? seen.filter((id): id is string => typeof id === 'string') : [];
    this.seen = list.slice(-MAX_SEEN);
    this.seenIds = new Set(this.seen);
  }

  all(): readonly TripSegment[] {
    return this.items;
  }

  get(id: string): TripSegment | undefined {
    return this.items.find((segment) => segment.id === id);
  }

  hasSeen(mailId: string): boolean {
    return this.seenIds.has(mailId);
  }

  async markSeen(mailId: string): Promise<void> {
    if (this.seenIds.has(mailId)) return;
    this.seenIds.add(mailId);
    this.seen.push(mailId);
    if (this.seen.length > MAX_SEEN) {
      const dropped = this.seen.splice(0, this.seen.length - MAX_SEEN);
      for (const id of dropped) this.seenIds.delete(id);
    }
    await this.kv.set(SEEN_KEY, this.seen);
  }

  /** Adds segments, skipping a booking that is already stored (a resend or reminder). */
  async add(segments: readonly TripSegment[]): Promise<TripSegment[]> {
    const added: TripSegment[] = [];
    for (const segment of segments) {
      if (this.items.some((existing) => sameBooking(existing, segment))) continue;
      this.items.push(segment);
      added.push(segment);
    }
    if (added.length === 0) return added;
    if (this.items.length > MAX_SEGMENTS) {
      this.items = [...this.items].sort((left, right) => left.start.localeCompare(right.start)).slice(-MAX_SEGMENTS);
    }
    await this.persistSegments();
    return added;
  }

  async removeById(id: string): Promise<TripSegment | undefined> {
    const index = this.items.findIndex((segment) => segment.id === id);
    if (index < 0) return undefined;
    const [removed] = this.items.splice(index, 1);
    await this.persistSegments();
    return removed;
  }

  /** Removes every segment whose booking reference matches a cancellation mail. */
  async removeByReferences(references: readonly string[]): Promise<TripSegment[]> {
    const wanted = new Set(references.map(normalizeReference).filter((reference) => reference !== ''));
    if (wanted.size === 0) return [];
    const removed = this.items.filter(
      (segment) => segment.reference !== undefined && wanted.has(normalizeReference(segment.reference)),
    );
    if (removed.length === 0) return [];
    this.items = this.items.filter((segment) => !removed.includes(segment));
    await this.persistSegments();
    return removed;
  }

  async setAll(segments: readonly TripSegment[]): Promise<void> {
    this.items = [...segments];
    await this.persistSegments();
  }

  private persistSegments(): Promise<void> {
    return this.kv.set(SEGMENTS_KEY, this.items);
  }
}
