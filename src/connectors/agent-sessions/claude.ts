import { join } from 'node:path';
import type { AgentSession } from '../../core/contracts/sessions.js';
import type { SessionFile, SessionFs } from './fs.js';
import { jsonLines, listDir, regularFile } from './fs.js';
import type { Turn } from './text.js';
import {
  MAX_FILE_BYTES,
  MAX_SESSIONS,
  checkAbort,
  firstPromptLine,
  isoFrom,
  maskedOptional,
  ownerText,
  record,
  renderTranscript,
  safeId,
  str,
} from './text.js';

/** Visible text of a message: a plain string, or the `text` blocks of a block array. Undefined when none. */
function visibleText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const b = record(block);
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text);
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

/** One owner or assistant turn from a Claude Code line, or undefined for everything else. */
export function claudeTurn(line: Record<string, unknown>): Turn | undefined {
  if (line.isMeta === true) return undefined;
  if (line.type !== 'user' && line.type !== 'assistant') return undefined;
  const message = record(line.message);
  if (message === undefined) return undefined;
  const raw = visibleText(message.content);
  if (raw === undefined) return undefined;
  if (line.type === 'user') {
    const text = ownerText(raw);
    return text.length > 0 ? { role: 'owner', text } : undefined;
  }
  const text = raw.trim();
  return text.length > 0 ? { role: 'assistant', text } : undefined;
}

/** Top-level `<slug>/<id>.jsonl` files, newest first, capped. Subfolders and links are ignored. */
export async function claudeFiles(fs: SessionFs, home: string, signal?: AbortSignal): Promise<SessionFile[]> {
  const root = join(home, '.claude', 'projects');
  const files: SessionFile[] = [];
  for (const slug of await listDir(fs, root)) {
    checkAbort(signal);
    if (!slug.isDirectory || slug.isSymbolicLink) continue;
    const dir = join(root, slug.name);
    for (const entry of await listDir(fs, dir)) {
      if (!entry.isFile || entry.isSymbolicLink || !entry.name.endsWith('.jsonl')) continue;
      const id = entry.name.slice(0, -'.jsonl'.length);
      if (!safeId(id)) continue;
      const path = join(dir, entry.name);
      const info = await regularFile(fs, path);
      if (info === undefined || info.size > MAX_FILE_BYTES) continue;
      files.push({ id, path, mtimeMs: info.mtimeMs });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return files.slice(0, MAX_SESSIONS);
}

/** One pass over a session file for its metadata. Undefined when the owner never wrote in it. */
export async function readClaudeSession(fs: SessionFs, file: SessionFile): Promise<AgentSession | undefined> {
  let first: string | undefined;
  let last: string | undefined;
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let firstPrompt: string | undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let summary: string | undefined;
  let turns = 0;
  try {
    for await (const line of jsonLines(fs, file.path)) {
      customTitle = str(line.customTitle) ?? customTitle;
      aiTitle = str(line.aiTitle) ?? aiTitle;
      if (line.type === 'summary') summary = str(line.summary) ?? summary;
      if (line.type !== 'user' && line.type !== 'assistant') continue;
      const at = isoFrom(line.timestamp);
      if (at !== undefined) {
        first ??= at;
        last = at;
      }
      cwd ??= str(line.cwd);
      gitBranch = str(line.gitBranch) ?? gitBranch;
      const turn = claudeTurn(line);
      if (turn?.role !== 'owner') continue;
      turns += 1;
      firstPrompt ??= turn.text;
    }
  } catch {
    // Unreadable midway (removed, permission): whatever was read so far still counts.
  }
  if (turns === 0 || cwd === undefined) return undefined;
  const fallback = new Date(file.mtimeMs).toISOString();
  const title = maskedOptional(customTitle ?? aiTitle ?? summary);
  const branch = gitBranch !== undefined && gitBranch !== 'HEAD' ? maskedOptional(gitBranch) : undefined;
  return {
    tool: 'claude',
    id: file.id,
    cwd,
    ...(title !== undefined ? { title } : {}),
    ...(firstPrompt !== undefined ? { firstPrompt: firstPromptLine(firstPrompt) } : {}),
    startedAt: first ?? fallback,
    updatedAt: last ?? fallback,
    turns,
    ...(branch !== undefined ? { gitBranch: branch } : {}),
  };
}

/** Claude Code sessions under `<home>/.claude/projects`. */
export class ClaudeSessions {
  private readonly paths = new Map<string, string>();

  constructor(
    private readonly fs: SessionFs,
    private readonly home: string,
  ) {}

  async list(signal?: AbortSignal): Promise<AgentSession[]> {
    const sessions: AgentSession[] = [];
    for (const file of await claudeFiles(this.fs, this.home, signal)) {
      checkAbort(signal);
      this.paths.set(file.id, file.path);
      const session = await readClaudeSession(this.fs, file);
      if (session !== undefined) sessions.push(session);
    }
    return sessions;
  }

  async transcript(id: string, maxChars: number): Promise<string | undefined> {
    const path = await this.find(id);
    if (path === undefined) return undefined;
    const turns: Turn[] = [];
    try {
      for await (const line of jsonLines(this.fs, path)) {
        const turn = claudeTurn(line);
        if (turn !== undefined) turns.push(turn);
      }
    } catch {
      return undefined;
    }
    return renderTranscript(turns, maxChars);
  }

  private async find(id: string): Promise<string | undefined> {
    if (!safeId(id)) return undefined;
    const known = this.paths.get(id);
    if (known !== undefined) {
      const info = await regularFile(this.fs, known);
      if (info !== undefined && info.size <= MAX_FILE_BYTES) return known;
    }
    const root = join(this.home, '.claude', 'projects');
    for (const slug of await listDir(this.fs, root)) {
      if (!slug.isDirectory || slug.isSymbolicLink) continue;
      const path = join(root, slug.name, `${id}.jsonl`);
      const info = await regularFile(this.fs, path);
      if (info !== undefined && info.size <= MAX_FILE_BYTES) return path;
    }
    return undefined;
  }
}
