/** Which coding assistant left the session on this computer. */
export type AgentTool = 'claude' | 'codex';

/** One Claude Code or Codex session found on disk. Read-only; nothing here is ever changed. */
export interface AgentSession {
  tool: AgentTool;
  /** Stable within the tool (Claude: the jsonl file name; Codex: the thread id). */
  id: string;
  /** Absolute folder the session worked in. */
  cwd: string;
  /** The tool's own title for it, secrets masked. */
  title?: string;
  /** The owner's first request, one line, masked, at most 200 characters. */
  firstPrompt?: string;
  /** ISO 8601. */
  startedAt: string;
  /** ISO 8601 of the last message. */
  updatedAt: string;
  /** How many times the owner wrote in it. */
  turns: number;
  gitBranch?: string;
  /** "github.com/owner/repo" style, credentials removed. */
  gitRemote?: string;
}

/** Capability "sessions.agents": past coding sessions, for the first look at what the owner works on. */
export interface AgentSessionReader {
  /** Every session on this computer, newest first. A missing tool folder is simply no sessions. */
  list(signal?: AbortSignal): Promise<readonly AgentSession[]>;
  /**
   * The conversation as plain text ("owner: …" / "assistant: …" lines). Tool calls, tool output, thinking and
   * attachments are left out; secrets, emails and phone numbers masked. Longer than `maxChars`: the start and the end
   * are kept with a "…" between. Undefined when the session can no longer be read.
   */
  transcript(session: Pick<AgentSession, 'tool' | 'id'>, maxChars: number): Promise<string | undefined>;
}
