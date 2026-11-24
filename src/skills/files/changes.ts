import type { FileChangeKind, FileChangeRecord } from '../../core/contracts/files.js';
import type { KeyValueStore } from '../../core/store/types.js';

export const MAX_CHANGES = 500;
const CHANGES_KEY = 'changes';
const KINDS: readonly FileChangeKind[] = ['added', 'changed', 'removed'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecords(value: unknown): FileChangeRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isRecord(item) &&
    typeof item.path === 'string' &&
    typeof item.at === 'string' &&
    KINDS.includes(item.kind as FileChangeKind)
      ? [{ path: item.path, kind: item.kind as FileChangeKind, at: item.at }]
      : [],
  );
}

function normalizeFolder(folder: string): string {
  return folder
    .trim()
    .replace(/^~\/?/, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

/** True when `path` ("~/Documents/a.md") sits in `folder` ("Documents", "~/Documents/notes", "notes"). */
export function inFolder(path: string, folder: string): boolean {
  const wanted = normalizeFolder(folder);
  if (wanted === '') return true;
  const rel = normalizeFolder(path);
  return rel === wanted || rel.startsWith(`${wanted}/`) || rel.includes(`/${wanted}/`);
}

/** The last 500 file changes, oldest first, in the plugin's key-value store. */
export class ChangeLog {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly kv: KeyValueStore) {}

  async all(): Promise<FileChangeRecord[]> {
    return readRecords(await this.kv.get<unknown>(CHANGES_KEY));
  }

  add(records: readonly FileChangeRecord[]): Promise<void> {
    const next = this.queue.then(async () => {
      if (records.length === 0) return;
      const kept = [...(await this.all()), ...records].slice(-MAX_CHANGES);
      await this.kv.set(CHANGES_KEY, kept);
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Changes at or after `from`, newest first, optionally only inside one folder. */
  async since(from: Date, folder?: string): Promise<FileChangeRecord[]> {
    const cutoff = from.getTime();
    return (await this.all())
      .filter((record) => Date.parse(record.at) >= cutoff && (folder === undefined || inFolder(record.path, folder)))
      .reverse();
  }
}
