import type { FileEntry } from '../../core/contracts/files.js';
import type { KeyValueStore } from '../../core/store/types.js';

/** Files whose read failed are kept apart from the cursor (which moves past them) and tried again on later runs. */
export interface RetryEntry {
  entry: FileEntry;
  tries: number;
}

/** Tries before a file that keeps failing to read is left out (until it changes and the cursor lists it again). */
export const MAX_READ_TRIES = 5;
const MAX_RETRIES = 500;
const key = (source: string): string => `retry:${source}`;

function isEntry(value: unknown): value is FileEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.name === 'string' && typeof record.path === 'string' && typeof record.modifiedAt === 'string';
}

export async function loadRetries(kv: KeyValueStore, source: string): Promise<RetryEntry[]> {
  const stored = await kv.get<unknown>(key(source));
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((item: unknown): RetryEntry[] => {
    if (typeof item !== 'object' || item === null) return [];
    const { entry, tries } = item as Record<string, unknown>;
    return isEntry(entry) ? [{ entry, tries: typeof tries === 'number' ? tries : 1 }] : [];
  });
}

export async function saveRetries(kv: KeyValueStore, source: string, entries: readonly RetryEntry[]): Promise<void> {
  if (entries.length === 0) {
    await kv.delete(key(source));
    return;
  }
  await kv.set(key(source), entries.slice(-MAX_RETRIES));
}
