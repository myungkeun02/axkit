import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KeyValueStore } from '../../core/store/types.js';

/** `assembling`: every chunk is here and the audio file is being joined; it is published (renamed) before `transcribing`. */
export type RecordingStatus = 'receiving' | 'assembling' | 'transcribing' | 'summarizing' | 'done' | 'failed';

export interface Recording {
  id: string;
  title?: string;
  startedAt: string;
  durationSec: number;
  total: number;
  status: RecordingStatus;
  statusText?: string;
  documentId?: string;
  driveUrl?: string;
  /** D5: what the client recorded (the desktop app falls back to webm/opus when it cannot make AAC). */
  format?: 'm4a' | 'webm';
  updatedAt: string;
}

export function formatOf(contentType: string): 'm4a' | 'webm' {
  return /webm|opus|ogg/i.test(contentType) ? 'webm' : 'm4a';
}

export const RECORDING_ID = /^r_[a-z0-9-]{1,40}$/;
export const MAX_CHUNKS = 64;
const MAX_KEPT = 200;

const chunkName = (index: number): string => `chunk-${String(index).padStart(3, '0')}`;

/**
 * Recordings and their state. Audio and transcripts stay on this Mac, in `dir/<id>/` (mode 700/600). The list is one
 * kv entry; every change to it goes through one queue, so two uploads landing together never drop each other's write.
 */
export class RecordingStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kv: KeyValueStore,
    readonly dir: string,
  ) {}

  async list(): Promise<Recording[]> {
    return ((await this.kv.get<Recording[]>('list')) ?? []).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async get(id: string): Promise<Recording | undefined> {
    return (await this.list()).find((item) => item.id === id);
  }

  /** Runs one read-change-write of the list after every earlier one. */
  private serial<T>(change: (list: Recording[]) => { list?: Recording[]; result: T }): Promise<T> {
    const next = this.queue.then(async () => {
      const { list, result } = change(await this.list());
      if (list !== undefined) await this.kv.set('list', list.slice(0, MAX_KEPT));
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  async put(recording: Recording): Promise<void> {
    await this.serial((list) => ({ list: [recording, ...list.filter((item) => item.id !== recording.id)], result: undefined }));
  }

  /** Adds a recording unless one with this id exists; answers the one that is there now. */
  async create(recording: Recording): Promise<Recording> {
    return await this.serial((list) => {
      const found = list.find((item) => item.id === recording.id);
      return found !== undefined ? { result: found } : { list: [recording, ...list], result: recording };
    });
  }

  async update(id: string, patch: Partial<Recording>, now: Date, when?: (current: Recording) => boolean): Promise<Recording | undefined> {
    return await this.serial((list) => {
      const current = list.find((item) => item.id === id);
      if (current === undefined || (when !== undefined && !when(current))) return { result: undefined };
      const next = { ...current, ...patch, updatedAt: now.toISOString() };
      return { list: [next, ...list.filter((item) => item.id !== id)], result: next };
    });
  }

  folder(id: string): string {
    return join(this.dir, id);
  }

  async saveChunk(id: string, index: number, bytes: Buffer): Promise<void> {
    await mkdir(this.folder(id), { recursive: true, mode: 0o700 });
    await writeFile(join(this.folder(id), chunkName(index)), bytes, { mode: 0o600 });
  }

  /** How many chunks arrived with no gap from 0: where the phone resumes. */
  async contiguous(id: string): Promise<number> {
    const names = await readdir(this.folder(id)).catch(() => [] as string[]);
    const have = new Set(names.filter((name) => name.startsWith('chunk-')).map((name) => Number(name.slice(6))));
    let count = 0;
    while (have.has(count)) count += 1;
    return count;
  }

  /** Where the joined audio lives, by the recorded format. */
  audioPath(id: string, format: 'm4a' | 'webm' = 'm4a'): string {
    return join(this.folder(id), `audio.${format}`);
  }

  /**
   * Joins the byte chunks back into the phone's one audio file and drops the chunks. The file is written aside and
   * renamed into place, so the audio path only ever holds a whole file; chunks go only after that. Run again after a
   * crash, it finishes the job: a published file with its chunks (partly) gone is already done.
   */
  async assemble(id: string, total: number, format: 'm4a' | 'webm' = 'm4a'): Promise<string> {
    const path = this.audioPath(id, format);
    if ((await this.contiguous(id)) < total) {
      if (await exists(path)) return path;
      throw new Error(`recording ${id} is missing chunks`);
    }
    const parts: Buffer[] = [];
    for (let index = 0; index < total; index += 1) parts.push(await readFile(join(this.folder(id), chunkName(index))));
    const partial = `${path}.part`;
    await writeFile(partial, Buffer.concat(parts), { mode: 0o600 });
    await rename(partial, path);
    for (let index = 0; index < total; index += 1) await rm(join(this.folder(id), chunkName(index)), { force: true });
    return path;
  }

  async saveText(id: string, name: string, text: string): Promise<void> {
    await mkdir(this.folder(id), { recursive: true, mode: 0o700 });
    await writeFile(join(this.folder(id), name), text, { mode: 0o600 });
  }
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}
