import type { ProcessRunner } from '../../core/process/types.js';
import { mask } from './guard.js';
import { tail } from './text.js';

export interface CoderInput {
  dir: string;
  /** Other folders it may also edit (the app repos next to ax-kit in the "ax 개선" room). */
  extraDirs?: readonly string[];
  instructions: string;
  signal?: AbortSignal;
}

export interface CoderResult {
  ok: boolean;
  /** Last part of the output, with credentials masked. */
  log: string;
}

export interface Coder {
  write(input: CoderInput): Promise<CoderResult>;
}

const LOG_CHARS = 4000;

export interface CliCoderOptions {
  run: ProcessRunner;
  /** Executable name or path; defaults to "claude" or "codex". */
  command?: string;
  timeoutMs: number;
}

function coderLog(stdout: string, stderr: string): string {
  return mask(tail(`${stdout}\n${stderr}`.trim(), LOG_CHARS));
}

async function runCli(
  run: ProcessRunner,
  command: string,
  args: readonly string[],
  input: CoderInput,
  timeoutMs: number,
): Promise<CoderResult> {
  const result = await run(command, args, {
    cwd: input.dir,
    input: input.instructions,
    timeoutMs,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  return { ok: result.code === 0 && !result.timedOut, log: coderLog(result.stdout, result.stderr) };
}

/**
 * Claude Code in the worktree. No Bash tool on purpose: the coder edits files only, and this skill runs
 * the tests itself under its own timeout and guard.
 */
export class ClaudeCliCoder implements Coder {
  private readonly run: ProcessRunner;
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(options: CliCoderOptions) {
    this.run = options.run;
    this.command = options.command ?? 'claude';
    this.timeoutMs = options.timeoutMs;
  }

  write(input: CoderInput): Promise<CoderResult> {
    return runCli(
      this.run,
      this.command,
      [
        '-p',
        '--permission-mode',
        'acceptEdits',
        '--allowedTools',
        'Read Edit Write Grep Glob',
        // No shell, web or MCP servers from the owner's global setup: tests are run by ax-kit, not by the coder.
        '--disallowedTools',
        'Bash WebFetch WebSearch',
        '--strict-mcp-config',
        '--no-session-persistence',
        ...(input.extraDirs ?? []).flatMap((dir) => ['--add-dir', dir]),
      ],
      input,
      this.timeoutMs,
    );
  }
}

/** Codex CLI in the worktree, sandboxed to workspace writes and with its own config ignored. */
export class CodexCliCoder implements Coder {
  private readonly run: ProcessRunner;
  private readonly command: string;
  private readonly timeoutMs: number;

  constructor(options: CliCoderOptions) {
    this.run = options.run;
    this.command = options.command ?? 'codex';
    this.timeoutMs = options.timeoutMs;
  }

  write(input: CoderInput): Promise<CoderResult> {
    return runCli(
      this.run,
      this.command,
      ['exec', '--ephemeral', '--ignore-user-config', '--sandbox', 'workspace-write', '--skip-git-repo-check', ...(input.extraDirs ?? []).flatMap((dir) => ['--add-dir', dir]), '-'],
      input,
      this.timeoutMs,
    );
  }
}
