import type { FileEntry, FileSource } from '../../../src/core/contracts/files.js';

export function entry(overrides: Partial<FileEntry> & { id: string; modifiedAt: string }): FileEntry {
  return {
    name: overrides.id.split('/').at(-1) ?? overrides.id,
    path: `Files/${overrides.id}`,
    size: 10,
    ...overrides,
  };
}

export class FakeFileSource implements FileSource {
  readonly listCalls: { modifiedAfter?: Date; limit: number; oldestFirst?: boolean }[] = [];
  readonly readCalls: { id: string; maxBytes: number }[] = [];
  readonly contents = new Map<string, string>();
  /** Ids whose folder is "unreachable": entry() throws for them. */
  readonly unreachable = new Set<string>();
  failList: Error | undefined;
  readonly failReads = new Set<string>();

  constructor(
    readonly label: string,
    public entries: FileEntry[] = [],
  ) {}

  add(file: FileEntry, text: string): this {
    this.entries = this.entries.filter((existing) => existing.id !== file.id);
    this.entries.push(file);
    this.contents.set(file.id, text);
    return this;
  }

  remove(id: string): this {
    this.entries = this.entries.filter((file) => file.id !== id);
    this.contents.delete(id);
    return this;
  }

  async list(opts: { modifiedAfter?: Date; limit: number; oldestFirst?: boolean }): Promise<FileEntry[]> {
    this.listCalls.push(opts);
    if (this.failList !== undefined) throw this.failList;
    const after = opts.modifiedAfter?.getTime();
    const found = this.entries.filter((file) => after === undefined || Date.parse(file.modifiedAt) > after);
    const direction = opts.oldestFirst === true ? 1 : -1;
    found.sort((left, right) => direction * left.modifiedAt.localeCompare(right.modifiedAt) || left.id.localeCompare(right.id));
    return found.slice(0, opts.limit);
  }

  async entry(id: string): Promise<FileEntry | undefined> {
    if (this.unreachable.has(id)) throw new Error('unreachable');
    return this.entries.find((file) => file.id === id);
  }

  async readText(id: string, maxBytes: number): Promise<string> {
    this.readCalls.push({ id, maxBytes });
    if (this.failReads.has(id)) throw new Error('read failed');
    const text = this.contents.get(id);
    if (text === undefined) throw new Error('missing');
    return text.slice(0, maxBytes);
  }
}
