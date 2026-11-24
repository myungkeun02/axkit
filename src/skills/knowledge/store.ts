import type { KnowledgeLine, StoredKnowledgeLine } from '../../core/contracts/knowledge.js';
import type { KeyValueStore } from '../../core/store/types.js';
import { maskSecrets } from '../../core/text/mask.js';
import { lineId } from './ids.js';

export interface StoredLine extends StoredKnowledgeLine {
  /** A correction can erase a line without forgetting that the owner rejected it. */
  removed?: true;
}

const STORAGE_KEY = 'lines';
const MAX_LINES = 5_000;
const MAX_TEXT = 300;

type ReplaceOrigin = 'scan' | 'memory';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredLine(value: unknown): value is StoredLine {
  if (!isRecord(value)) return false;
  const origin = value['origin'];
  return (
    typeof value['id'] === 'string' &&
    typeof value['area'] === 'string' &&
    typeof value['topic'] === 'string' &&
    typeof value['key'] === 'string' &&
    typeof value['text'] === 'string' &&
    typeof value['at'] === 'string' &&
    (origin === 'scan' || origin === 'memory' || origin === 'file' || origin === 'correction') &&
    (value['removed'] === undefined || value['removed'] === true) &&
    Array.isArray(value['sources']) &&
    value['sources'].every((source) => typeof source === 'string')
  );
}

function sameSources(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((source, index) => source === right[index]);
}

function older(line: StoredLine, other: StoredLine): StoredLine {
  return line.at <= other.at ? line : other;
}

function trimText(text: string): string {
  return maskSecrets(text.trim()).slice(0, MAX_TEXT);
}

/**
 * The knowledge base stays append-only in spirit: scans and memory can only replace their own lines, and a
 * correction the owner made outranks both forever.
 */
export class KnowledgeStore {
  private lines: StoredLine[] = [];

  constructor(private readonly kv: KeyValueStore) {}

  async load(): Promise<void> {
    const stored = await this.kv.get<unknown>(STORAGE_KEY);
    this.lines = Array.isArray(stored) ? stored.filter(isStoredLine) : [];
  }

  all(): readonly StoredLine[] {
    return this.lines;
  }

  get(id: string): StoredLine | undefined {
    return this.lines.find((line) => line.id === id);
  }

  visible(): readonly StoredLine[] {
    return this.lines.filter((line) => line.removed !== true);
  }

  async replaceOrigin(origin: ReplaceOrigin, lines: readonly KnowledgeLine[]): Promise<{ added: number; retired: number }> {
    const incoming = new Map<string, KnowledgeLine>();
    for (const line of lines) {
      const id = lineId(line.area, line.topic, line.key);
      // Last wins: a source that repeats a key states its final value.
      incoming.set(id, line);
    }

    const kept = new Set<string>();
    const next: StoredLine[] = [];
    let added = 0;
    let retired = 0;

    for (const stored of this.lines) {
      const replacement = incoming.get(stored.id);
      if (stored.origin === 'correction') {
        kept.add(stored.id);
        next.push(stored);
        continue;
      }
      if (stored.origin !== origin) {
        kept.add(stored.id);
        next.push(stored);
        continue;
      }
      if (replacement === undefined) {
        retired += 1;
        continue;
      }
      incoming.delete(stored.id);
      kept.add(stored.id);
      if (stored.text === replacement.text && sameSources(stored.sources, replacement.sources)) {
        next.push(stored);
        continue;
      }
      next.push({ ...replacement, id: stored.id, origin });
      added += 1;
    }

    for (const [id, line] of incoming) {
      if (kept.has(id)) continue;
      next.push({ ...line, id, origin });
      added += 1;
    }

    const changed = added > 0 || retired > 0 || next.length !== this.lines.length;
    this.lines = next;
    this.prune();
    if (changed) await this.persist();
    return { added, retired };
  }

  /**
   * Lines the owner approved from a file: each replaces an inferred line with the same id; a line the owner corrected
   * stays as it is. Resolves to the lines put in and the ids left out because of a correction.
   */
  async addFileLines(lines: readonly KnowledgeLine[]): Promise<{ added: number; kept: string[] }> {
    const next = [...this.lines];
    const kept: string[] = [];
    let added = 0;
    for (const line of lines) {
      const id = lineId(line.area, line.topic, line.key);
      const index = next.findIndex((stored) => stored.id === id);
      const stored = next[index];
      if (stored?.origin === 'correction') {
        kept.push(id);
        continue;
      }
      const fresh: StoredLine = { ...line, text: trimText(line.text), id, origin: 'file' };
      if (stored === undefined) next.push(fresh);
      else next[index] = fresh;
      added += 1;
    }
    this.lines = next;
    this.prune();
    if (added > 0) await this.persist();
    return { added, kept };
  }

  /** The owner's own words. A tombstone keeps later scans from bringing the line back. */
  async correct(id: string, text: string | undefined, at: string): Promise<void> {
    const index = this.lines.findIndex((line) => line.id === id);
    const stored = this.lines[index];
    if (index < 0 || stored === undefined) throw new Error(`No knowledge line with id ${id}`);

    const corrected: StoredLine =
      text === undefined
        ? {
            id: stored.id,
            area: stored.area,
            topic: stored.topic,
            key: stored.key,
            text: '',
            sources: [],
            at,
            origin: 'correction',
            removed: true,
          }
        : {
            id: stored.id,
            area: stored.area,
            topic: stored.topic,
            key: stored.key,
            text: trimText(text),
            sources: [],
            at,
            origin: 'correction',
          };

    const next = [...this.lines];
    next[index] = corrected;
    this.lines = next;
    this.prune();
    await this.persist();
  }

  /** Over the cap, old inferred lines make way before anything the owner corrected. */
  private prune(): void {
    while (this.lines.length > MAX_LINES) {
      const inferred = this.lines.filter((line) => line.origin !== 'correction');
      const pool = inferred.length > 0 ? inferred : this.lines;
      const oldest = pool.reduce(older);
      this.lines = this.lines.filter((line) => line !== oldest);
    }
  }

  private persist(): Promise<void> {
    return this.kv.set(STORAGE_KEY, this.lines);
  }
}
