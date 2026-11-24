import { randomBytes } from 'node:crypto';
import type { ProcessRunner, RunOptions, RunResult } from '../../core/process/types.js';
import { mask } from './guard.js';

const FETCH_TIMEOUT_MS = 120_000;
const COMMAND_TIMEOUT_MS = 60_000;
const PUSH_TIMEOUT_MS = 120_000;
const MAX_DIFF_CHARS = 60_000;
const BRANCH_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;
const MANAGED_PREFIX = 'ax-kit/';

export function kebabTitle(title: string): string {
  const cleaned = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const clipped = cleaned.slice(0, 40).replace(/-+$/, '');
  return clipped === '' ? 'task' : clipped;
}

function validBranch(branch: string): boolean {
  return (
    BRANCH_PATTERN.test(branch) &&
    !branch.includes('..') &&
    !branch.includes('//') &&
    !branch.endsWith('/') &&
    !branch.endsWith('.')
  );
}

/** `ax-kit/<kebab title, at most 40>-<6 hex>`, validated so it can only name a branch this skill owns. */
export function branchName(title: string, hex: string): string {
  if (!/^[a-f0-9]{6}$/.test(hex)) throw new Error('Branch suffix must be six hex characters.');
  const branch = `${MANAGED_PREFIX}${kebabTitle(title)}-${hex}`;
  if (!validBranch(branch)) throw new Error('Could not build a valid branch name.');
  return branch;
}

export function newBranchName(title: string): string {
  return branchName(title, randomBytes(3).toString('hex'));
}

export function isManagedBranch(branch: string): boolean {
  return branch.startsWith(MANAGED_PREFIX) && validBranch(branch);
}

function parsePorcelain(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split('\n')) {
    if (line.length < 4) continue;
    const rest = line.slice(3);
    const arrow = rest.lastIndexOf(' -> ');
    const target = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    const cleaned = target.trim().replace(/^"|"$/g, '');
    if (cleaned !== '') paths.push(cleaned);
  }
  return paths;
}

/** Git over an injected runner: no shell, no interactive prompts, and the token never in argv. */
export class Git {
  constructor(
    private readonly run: ProcessRunner,
    /** Cancels every command this instance runs (a job's deadline or shutdown). */
    private readonly signal?: AbortSignal,
  ) {}

  /** The same git, with its commands cancelled by `signal`. */
  withSignal(signal: AbortSignal | undefined): Git {
    return signal === undefined ? this : new Git(this.run, signal);
  }

  async worktreeAdd(repoPath: string, dir: string, branch: string, base: string): Promise<void> {
    // a project that lives only on this Mac (no origin) starts from its own local base branch
    const origin = await this.run('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], { timeoutMs: COMMAND_TIMEOUT_MS }).catch(() => undefined);
    if (origin?.code !== 0) {
      await this.exec('worktree add', ['-C', repoPath, 'worktree', 'add', '-b', branch, dir, base]);
      return;
    }
    await this.exec('fetch', ['-C', repoPath, 'fetch', 'origin', base], FETCH_TIMEOUT_MS);
    await this.exec('worktree add', ['-C', repoPath, 'worktree', 'add', '-b', branch, dir, `origin/${base}`]);
  }

  /** Checks out an existing ax-kit branch into `dir` (resuming a job whose worktree is gone). */
  async worktreeAttach(repoPath: string, dir: string, branch: string): Promise<void> {
    if (!isManagedBranch(branch)) throw new Error('Refusing to check out a branch ax-kit did not create.');
    await this.exec('worktree add', ['-C', repoPath, 'worktree', 'add', dir, branch]);
  }

  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    if (!validBranch(branch)) return false;
    try {
      const result = await this.run('git', ['-C', repoPath, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {
        timeoutMs: COMMAND_TIMEOUT_MS,
        ...(this.signal !== undefined ? { signal: this.signal } : {}),
      });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  async changedFiles(dir: string): Promise<string[]> {
    const result = await this.exec('status', ['-C', dir, 'status', '--porcelain']);
    return parsePorcelain(result.stdout);
  }

  /**
   * Stages everything so untracked files show up in `diff` and `diffStat`. The secret scan must see new files
   * too, so it runs on the staged diff.
   */
  async stageAll(dir: string): Promise<void> {
    await this.exec('add', ['-C', dir, 'add', '-A']);
  }

  async diffStat(dir: string): Promise<string> {
    const result = await this.exec('diff stat', ['-C', dir, 'diff', '--cached', '--stat']);
    return result.stdout.trim();
  }

  async diff(dir: string, maxChars = MAX_DIFF_CHARS): Promise<string> {
    const result = await this.exec('diff', ['-C', dir, 'diff', '--cached', '--no-color', '--unified=3']);
    return result.stdout.slice(0, maxChars);
  }

  async commitAll(dir: string, message: string): Promise<string> {
    await this.stageAll(dir);
    await this.exec('commit', ['-C', dir, 'commit', '-m', message]);
    const result = await this.exec('rev-parse', ['-C', dir, 'rev-parse', 'HEAD']);
    return result.stdout.trim();
  }

  async push(dir: string, branch: string, token: string): Promise<void> {
    if (!validBranch(branch) || !branch.startsWith(MANAGED_PREFIX)) throw new Error('Invalid branch name.');
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    const env: Record<string, string> = {
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basic}`,
    };
    await this.exec('push', ['-C', dir, 'push', 'origin', `${branch}:${branch}`], PUSH_TIMEOUT_MS, env);
  }

  async worktreeRemove(repoPath: string, dir: string, branch: string): Promise<void> {
    if (!isManagedBranch(branch)) throw new Error('Refusing to delete a branch ax-kit did not create.');
    await this.exec('worktree remove', ['-C', repoPath, 'worktree', 'remove', '--force', dir]);
    await this.exec('branch delete', ['-C', repoPath, 'branch', '-D', branch]);
  }

  private async exec(
    label: string,
    args: readonly string[],
    timeoutMs = COMMAND_TIMEOUT_MS,
    env?: Readonly<Record<string, string>>,
  ): Promise<RunResult> {
    // never start a command once the job was cancelled
    this.signal?.throwIfAborted();
    const options: RunOptions = {
      timeoutMs,
      ...(env !== undefined ? { env } : {}),
      ...(this.signal !== undefined ? { signal: this.signal } : {}),
    };
    let result: RunResult;
    try {
      result = await this.run('git', args, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`git ${label} could not start: ${mask(message).slice(0, 300)}`);
    }
    if (result.code !== 0) {
      const detail = mask(result.stderr.trim() || result.stdout.trim()).slice(0, 300);
      throw new Error(`git ${label} failed (${result.code}): ${detail}`);
    }
    return result;
  }
}
