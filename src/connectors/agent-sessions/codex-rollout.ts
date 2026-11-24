import { basename, join } from 'node:path';
import type { SessionFile, SessionFs } from './fs.js';
import { jsonLines, listDir, regularFile } from './fs.js';
import type { Role, Turn } from './text.js';
import { MAX_FILE_BYTES, MAX_SESSIONS, checkAbort, isoFrom, ownerText, record, str } from './text.js';

/** `event_msg` lines and `response_item` lines repeat the same turns; one source per role is used. */
type Source = 'event' | 'item';

interface Entry {
  role: Role;
  source: Source;
  text: string;
}

export interface RolloutScan {
  id?: string;
  cwd?: string;
  gitBranch?: string;
  gitRemote?: string;
  startedAt?: string;
  updatedAt?: string;
  turns: number;
  firstPrompt?: string;
  /** Only when asked for. */
  transcript?: Turn[];
}

const MAX_DEPTH = 4;
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** Context Codex injects as a "user" message: environment, AGENTS.md, permissions. */
const INJECTED = /^(?:<([\w -]+)>[\s\S]*<\/\1>|# AGENTS\.md instructions[\s\S]*)$/;

/** The id Codex gives a rollout file name: the trailing uuid, else the bare name. */
export function rolloutIdFromName(path: string): string {
  const name = basename(path);
  return UUID.exec(name)?.[1] ?? name.replace(/\.jsonl$/, '');
}

/** `rollout-*.jsonl` under `<home>/.codex/sessions`, at most four folders deep, newest first, capped. */
export async function rolloutFiles(fs: SessionFs, home: string, signal?: AbortSignal): Promise<SessionFile[]> {
  const files: SessionFile[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await listDir(fs, dir)) {
      checkAbort(signal);
      if (entry.isSymbolicLink) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory && depth < MAX_DEPTH) await walk(path, depth + 1);
      else if (entry.isFile && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        const info = await regularFile(fs, path);
        if (info !== undefined && info.size <= MAX_FILE_BYTES) {
          files.push({ id: rolloutIdFromName(path), path, mtimeMs: info.mtimeMs });
        }
      }
    }
  };
  await walk(join(home, '.codex', 'sessions'), 1);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, MAX_SESSIONS);
}

function blockText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const b = record(block);
    if ((b?.type === 'input_text' || b?.type === 'output_text' || b?.type === 'text') && typeof b.text === 'string') {
      parts.push(b.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** An owner or assistant entry from one rollout line, or undefined. */
function entryOf(type: unknown, payload: Record<string, unknown>): Entry | undefined {
  if (type === 'event_msg') {
    const message = str(payload.message);
    if (message === undefined) return undefined;
    if (payload.type === 'user_message') {
      const text = ownerText(message);
      return text.length > 0 ? { role: 'owner', source: 'event', text } : undefined;
    }
    if (payload.type === 'agent_message') return { role: 'assistant', source: 'event', text: message };
    return undefined;
  }
  if (type !== 'response_item' || payload.type !== 'message') return undefined;
  const raw = blockText(payload.content);
  if (raw === undefined) return undefined;
  if (payload.role === 'user') {
    if (INJECTED.test(raw.trim())) return undefined;
    const text = ownerText(raw);
    return text.length > 0 ? { role: 'owner', source: 'item', text } : undefined;
  }
  if (payload.role === 'assistant') {
    const text = raw.trim();
    return text.length > 0 ? { role: 'assistant', source: 'item', text } : undefined;
  }
  return undefined;
}

function applyMeta(scan: RolloutScan, payload: Record<string, unknown>): void {
  const id = str(payload.id);
  const cwd = str(payload.cwd);
  if (id !== undefined) scan.id ??= id;
  if (cwd !== undefined) scan.cwd ??= cwd;
  const at = isoFrom(payload.timestamp);
  if (at !== undefined) scan.startedAt ??= at;
  const git = record(payload.git);
  if (git === undefined) return;
  const branch = str(git.branch);
  const remote = str(git.repository_url);
  if (branch !== undefined) scan.gitBranch ??= branch;
  if (remote !== undefined) scan.gitRemote ??= remote;
}

/**
 * One pass over a rollout file. Owner turns come from `event_msg/user_message` when the file has them (they are
 * what the owner typed), else from `response_item` user messages minus injected context; assistant turns prefer
 * `response_item`. Unknown shapes are skipped. Throws only when the file cannot be opened.
 */
export async function scanRollout(fs: SessionFs, path: string, withText: boolean): Promise<RolloutScan> {
  const scan: RolloutScan = { turns: 0 };
  const counts = { event: 0, item: 0 };
  const firsts: Partial<Record<Source, string>> = {};
  const assistantFrom = { event: 0, item: 0 };
  const entries: Entry[] = [];
  try {
    for await (const line of jsonLines(fs, path)) {
      const at = isoFrom(line.timestamp);
      if (at !== undefined) {
        scan.startedAt ??= at;
        scan.updatedAt = at;
      }
      const payload = record(line.payload);
      if (payload === undefined) continue;
      if (line.type === 'session_meta') {
        applyMeta(scan, payload);
        const nested = record(payload.meta);
        if (nested !== undefined) applyMeta(scan, nested);
        continue;
      }
      const contextCwd = line.type === 'turn_context' ? str(payload.cwd) : undefined;
      if (contextCwd !== undefined) scan.cwd ??= contextCwd;
      const entry = entryOf(line.type, payload);
      if (entry === undefined) continue;
      if (entry.role === 'owner') {
        counts[entry.source] += 1;
        firsts[entry.source] ??= entry.text;
      } else assistantFrom[entry.source] += 1;
      if (withText) entries.push(entry);
    }
  } catch (error) {
    if (scan.startedAt === undefined && counts.event + counts.item === 0) throw error;
  }
  const owner: Source = counts.event > 0 ? 'event' : 'item';
  const assistant: Source = assistantFrom.item > 0 ? 'item' : 'event';
  scan.turns = counts[owner];
  const first = firsts[owner];
  if (first !== undefined) scan.firstPrompt = first;
  if (withText) {
    scan.transcript = entries
      .filter((e) => (e.role === 'owner' ? e.source === owner : e.source === assistant))
      .map((e) => ({ role: e.role, text: e.text }));
  }
  return scan;
}
