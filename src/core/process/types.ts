export interface RunOptions {
  /** Written to stdin, then stdin is closed. Prompts go here so they never show in the process list. */
  input?: string;
  cwd?: string;
  /** Added on top of the parent environment. Tokens go here, never into argv. */
  env?: Readonly<Record<string, string>>;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs one program without a shell. Never throws for a non-zero exit; throws only when it cannot start. */
export type ProcessRunner = (cmd: string, args: readonly string[], opts: RunOptions) => Promise<RunResult>;
