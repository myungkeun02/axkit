import { maskSecrets } from './mask.js';

/** Fields that let a later turn point back at an item ("두 번째 거 답장해줘"). */
const KEYS = ['id', 'messageId', 'threadId', 'eventId', 'title', 'subject', 'name', 'from', 'to', 'date', 'start', 'when', 'url', 'path'] as const;
const VALUE_CHARS = 60;
const LINE_CHARS = 200;
const ITEMS_PER_TOOL = 8;
export const REFS_PER_TURN_CHARS = 1_200;

/** The compact references one turn's tools returned, kept for the next few turns. */
export interface ToolRefTurn {
  at: string;
  lines: string[];
}

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return clip(value, VALUE_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    // a sender as { name, email }
    return scalar(record['email']) ?? scalar(record['name']);
  }
  return undefined;
}

function picked(item: unknown): string | undefined {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return scalar(item);
  const record = item as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of KEYS) {
    const value = scalar(record[key]);
    if (value !== undefined) parts.push(`${key}=${value}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/** The list a tool returned: the output itself, or its first array field ({ mails: [...] }). */
function listOf(output: unknown): unknown[] | undefined {
  if (Array.isArray(output)) return output;
  if (typeof output !== 'object' || output === null) return undefined;
  for (const value of Object.values(output)) if (Array.isArray(value) && value.length > 0) return value;
  return undefined;
}

/** "mail.search #2: id=…, subject=…" lines, numbered in the order the tool returned them. */
export function refsOf(tool: string, output: unknown): string[] {
  const list = listOf(output);
  if (list !== undefined) {
    const lines: string[] = [];
    list.slice(0, ITEMS_PER_TOOL).forEach((item, index) => {
      const text = picked(item);
      if (text !== undefined) lines.push(maskSecrets(clip(`${tool} #${index + 1}: ${text}`, LINE_CHARS)));
    });
    if (list.length > ITEMS_PER_TOOL) lines.push(`${tool}: … ${list.length - ITEMS_PER_TOOL} more`);
    return lines;
  }
  const one = picked(output);
  return one === undefined ? [] : [maskSecrets(clip(`${tool}: ${one}`, LINE_CHARS))];
}

/** One short line of what a tool returned, for the pending entry and a reply built from tool results. */
export function shortResult(output: unknown): string {
  if (typeof output === 'object' && output !== null && !Array.isArray(output)) {
    const message = (output as Record<string, unknown>)['message'];
    if (typeof message === 'string' && message.trim() !== '') return maskSecrets(clip(message, 120));
  }
  const list = listOf(output);
  if (list !== undefined) return `${list.length}`;
  return maskSecrets(clip(picked(output) ?? scalars(output), 120));
}

/** The first few plain fields of an object ("saved=우유"), when it has none of the reference fields. */
function scalars(output: unknown): string {
  if (typeof output !== 'object' || output === null) return scalar(output) ?? '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(output)) {
    const text = typeof value === 'object' ? undefined : scalar(value);
    if (text !== undefined) parts.push(`${key}=${text}`);
    if (parts.length >= 3) break;
  }
  return parts.join(', ');
}

/** Keeps the newest turns within the size cap. */
export function keepRefs(previous: readonly ToolRefTurn[], next: ToolRefTurn | undefined, turns: number): ToolRefTurn[] {
  const all = next === undefined || next.lines.length === 0 ? [...previous] : [...previous, next];
  return all.slice(-turns);
}

/** Caps one turn's lines to the per-turn size. */
export function capLines(lines: readonly string[]): string[] {
  const out: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length > REFS_PER_TURN_CHARS) break;
    out.push(line);
    size += line.length + 1;
  }
  return out;
}
