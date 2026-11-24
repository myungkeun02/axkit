import type { KnowledgeLine, StoredKnowledgeLine } from '../../../src/core/contracts/knowledge.js';
import type { KnowledgeOrigin } from '../../../src/core/contracts/knowledge.js';
import { lineId } from '../../../src/skills/knowledge/ids.js';
import type { DocFs } from '../../../src/skills/knowledge/writer.js';

export interface LineOptions {
  area?: string;
  topic?: string;
  key?: string;
  text?: string;
  sources?: string[];
  at?: string;
  origin?: KnowledgeOrigin;
  id?: string;
}

export function line(opts: LineOptions = {}): KnowledgeLine {
  const area = opts.area ?? 'work';
  return {
    area,
    topic: opts.topic ?? '회사',
    key: opts.key ?? 'k',
    text: opts.text ?? '기본 내용',
    sources: opts.sources ?? ['memory:chat'],
    at: opts.at ?? '2026-11-10T09:00:00+09:00',
  };
}

export function stored(opts: LineOptions = {}): StoredKnowledgeLine {
  const area = opts.area ?? 'work';
  const topic = opts.topic ?? '회사';
  const key = opts.key ?? 'k';
  const at = opts.at ?? '2026-11-10T09:00:00+09:00';
  return {
    id: opts.id ?? lineId(area, topic, key),
    area,
    topic,
    key,
    text: opts.text ?? '기본 내용',
    sources: opts.sources ?? ['memory:chat'],
    at,
    origin: opts.origin ?? 'scan',
  };
}

/** Keeps files and every mode in memory so tests see exactly what a real filesystem would receive. */
export class MemoryDocFs implements DocFs {
  readonly files = new Map<string, string>();
  readonly dirs: { path: string; mode: number }[] = [];
  readonly writes: { path: string; mode: number }[] = [];
  readonly chmods: { path: string; mode: number }[] = [];
  readonly removed: string[] = [];

  async mkdir(path: string, mode: number): Promise<void> {
    this.dirs.push({ path, mode });
  }

  async writeFile(path: string, data: string, mode: number): Promise<void> {
    this.writes.push({ path, mode });
    this.files.set(path, data);
  }

  async rename(from: string, to: string): Promise<void> {
    const data = this.files.get(from);
    if (data === undefined) throw new Error(`missing temporary file ${from}`);
    this.files.delete(from);
    this.files.set(to, data);
  }

  async readFile(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }

  async rm(path: string): Promise<void> {
    this.removed.push(path);
    this.files.delete(path);
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.chmods.push({ path, mode });
  }
}
