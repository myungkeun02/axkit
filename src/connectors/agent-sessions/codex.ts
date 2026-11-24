import type { AgentSession } from '../../core/contracts/sessions.js';
import type { CodexThreadRow } from './codex-db.js';
import { readCodexThreads } from './codex-db.js';
import type { RolloutScan } from './codex-rollout.js';
import { rolloutFiles, scanRollout } from './codex-rollout.js';
import type { SessionFs } from './fs.js';
import { regularFile } from './fs.js';
import {
  MAX_FILE_BYTES,
  MAX_SESSIONS,
  checkAbort,
  cleanRemote,
  firstPromptLine,
  maskedOptional,
  ownerText,
  renderTranscript,
} from './text.js';

async function readable(fs: SessionFs, path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined;
  const info = await regularFile(fs, path);
  return info !== undefined && info.size <= MAX_FILE_BYTES ? path : undefined;
}

async function scanQuietly(fs: SessionFs, path: string | undefined): Promise<RolloutScan | undefined> {
  if (path === undefined) return undefined;
  try {
    return await scanRollout(fs, path, false);
  } catch {
    return undefined;
  }
}

/** The database row wins for what it holds; the rollout file fills turns, times and anything missing. */
function toSession(id: string, row: CodexThreadRow | undefined, scan: RolloutScan | undefined): AgentSession | undefined {
  const cwd = row?.cwd ?? scan?.cwd;
  if (cwd === undefined) return undefined;
  const fromRow = row?.firstUserMessage !== undefined ? ownerText(row.firstUserMessage) : '';
  const prompt = fromRow.length > 0 ? fromRow : scan?.firstPrompt;
  const turns = scan !== undefined && scan.turns > 0 ? scan.turns : prompt !== undefined ? 1 : 0;
  if (turns === 0) return undefined;
  const startedAt = row?.startedAt ?? scan?.startedAt ?? scan?.updatedAt;
  const updatedAt = latest(row?.updatedAt, scan?.updatedAt) ?? startedAt;
  if (startedAt === undefined || updatedAt === undefined) return undefined;
  const title = maskedOptional(row?.title);
  const branch = maskedOptional(row?.gitBranch ?? scan?.gitBranch);
  const remote = cleanRemote(row?.gitOrigin ?? scan?.gitRemote);
  return {
    tool: 'codex',
    id,
    cwd,
    ...(title !== undefined ? { title } : {}),
    ...(prompt !== undefined ? { firstPrompt: firstPromptLine(prompt) } : {}),
    startedAt,
    updatedAt,
    turns,
    ...(branch !== undefined ? { gitBranch: branch } : {}),
    ...(remote !== undefined ? { gitRemote: remote } : {}),
  };
}

function latest(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a > b ? a : b;
}

/** Codex threads from `state_*.sqlite` and `sessions/**\/rollout-*.jsonl`, de-duplicated by id. */
export class CodexSessions {
  private readonly paths = new Map<string, string>();

  constructor(
    private readonly fs: SessionFs,
    private readonly home: string,
  ) {}

  async list(signal?: AbortSignal): Promise<AgentSession[]> {
    const rows = await readCodexThreads(this.fs, this.home);
    checkAbort(signal);
    const files = await rolloutFiles(this.fs, this.home, signal);
    const fileById = new Map(files.map((f) => [f.id, f.path]));
    const seen = new Set<string>();
    const sessions: AgentSession[] = [];
    for (const row of rows) {
      checkAbort(signal);
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const path = (await readable(this.fs, row.rolloutPath)) ?? fileById.get(row.id);
      if (path !== undefined) this.paths.set(row.id, path);
      const session = toSession(row.id, row, await scanQuietly(this.fs, path));
      if (session !== undefined) sessions.push(session);
    }
    for (const file of files) {
      if (sessions.length >= MAX_SESSIONS) break;
      if (seen.has(file.id)) continue;
      checkAbort(signal);
      const scan = await scanQuietly(this.fs, file.path);
      const id = scan?.id ?? file.id;
      if (seen.has(id)) continue;
      seen.add(file.id);
      seen.add(id);
      this.paths.set(id, file.path);
      const session = toSession(id, undefined, scan);
      if (session !== undefined) sessions.push(session);
    }
    return sessions;
  }

  async transcript(id: string, maxChars: number): Promise<string | undefined> {
    let path = await readable(this.fs, this.paths.get(id));
    if (path === undefined) {
      this.paths.clear();
      await this.list();
      path = await readable(this.fs, this.paths.get(id));
    }
    if (path === undefined) return undefined;
    try {
      const scan = await scanRollout(this.fs, path, true);
      return renderTranscript(scan.transcript ?? [], maxChars);
    } catch {
      return undefined;
    }
  }
}
