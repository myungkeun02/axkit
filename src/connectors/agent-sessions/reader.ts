import type { AgentSession, AgentSessionReader } from '../../core/contracts/sessions.js';
import { ClaudeSessions } from './claude.js';
import { CodexSessions } from './codex.js';
import type { SessionFs } from './fs.js';
import { MAX_SESSIONS, checkAbort } from './text.js';

export interface LocalAgentSessionReaderOptions {
  fs: SessionFs;
  /** The folder holding `.claude` and `.codex`. */
  home: string;
}

/** Claude Code and Codex sessions left on this computer. Read-only: nothing is ever written. */
export class LocalAgentSessionReader implements AgentSessionReader {
  private readonly claude: ClaudeSessions;
  private readonly codex: CodexSessions;

  constructor(opts: LocalAgentSessionReaderOptions) {
    this.claude = new ClaudeSessions(opts.fs, opts.home);
    this.codex = new CodexSessions(opts.fs, opts.home);
  }

  async list(signal?: AbortSignal): Promise<readonly AgentSession[]> {
    const claude = await this.claude.list(signal);
    checkAbort(signal);
    const codex = await this.codex.list(signal);
    const all = [...claude, ...codex];
    all.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return all.slice(0, MAX_SESSIONS);
  }

  async transcript(session: Pick<AgentSession, 'tool' | 'id'>, maxChars: number): Promise<string | undefined> {
    return session.tool === 'claude'
      ? await this.claude.transcript(session.id, maxChars)
      : session.tool === 'codex'
        ? await this.codex.transcript(session.id, maxChars)
        : undefined;
  }
}
