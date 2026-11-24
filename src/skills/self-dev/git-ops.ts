import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProcessRunner } from '../../core/process/types.js';

const GIT_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 15 * 60_000;
const TAIL = 3000;
/** Who the assistant's own commits are from. */
const AUTHOR = ['-c', 'user.name=ax-kit', '-c', 'user.email=ax-kit@localhost'];
/** Everything in a worktree but the borrowed packages link. */
const ALL = ['--', '.', ':(exclude)node_modules'];

export interface GitEnv {
  /** The running checkout. */
  root: string;
  run: ProcessRunner;
}

export const tail = (text: string): string => (text.length > TAIL ? text.slice(-TAIL) : text);

export async function git(env: GitEnv, args: readonly string[], cwd = env.root): Promise<{ ok: boolean; out: string }> {
  const result = await env.run('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, timeoutMs: GIT_TIMEOUT_MS }).catch((error: unknown) => ({ code: 1, stdout: '', stderr: String(error), timedOut: false }));
  return { ok: result.code === 0, out: `${result.stdout}${result.stderr}`.trim() };
}

export async function headOf(env: GitEnv, cwd = env.root): Promise<string | undefined> {
  const head = await git(env, ['rev-parse', 'HEAD'], cwd);
  return head.ok ? head.out.split('\n')[0] : undefined;
}

/** A worktree of the running checkout on a new branch from `base`; the packages are borrowed (never committed). */
export async function openWorktree(env: GitEnv, dir: string, branch: string, base: string): Promise<{ ok: boolean; out: string }> {
  const added = await git(env, ['worktree', 'add', '-b', branch, dir, base]);
  if (added.ok) await symlink(join(env.root, 'node_modules'), join(dir, 'node_modules')).catch(() => undefined);
  return added;
}

export async function closeWorktree(env: GitEnv, dir: string, branch: string, keepBranch = false): Promise<void> {
  await git(env, ['worktree', 'remove', '--force', dir]);
  if (!keepBranch) await git(env, ['branch', '-D', branch]);
}

/** Commits what changed in the worktree; 'none' when nothing did. */
export async function commitAll(env: GitEnv, dir: string, message: string): Promise<'committed' | 'none' | { error: string }> {
  const changed = await git(env, ['status', '--porcelain', ...ALL], dir);
  if (changed.out === '') return 'none';
  await git(env, ['add', '-A', ...ALL], dir);
  const committed = await git(env, [...AUTHOR, 'commit', '-q', '-m', message], dir);
  return committed.ok ? 'committed' : { error: committed.out };
}

/** Merges a finished piece's branch into this worktree; on a conflict the markers stay for the coder to resolve. */
export async function mergeBranch(env: GitEnv, dir: string, branch: string, message: string): Promise<'merged' | 'conflict' | { error: string }> {
  const merged = await git(env, [...AUTHOR, 'merge', '--no-ff', '-m', message, branch], dir);
  if (merged.ok) return 'merged';
  const unmerged = await git(env, ['diff', '--name-only', '--diff-filter=U'], dir);
  return unmerged.out !== '' ? 'conflict' : { error: merged.out };
}

/** Finishes a merge the coder resolved; refuses while conflict markers are left. */
export async function finishMerge(env: GitEnv, dir: string): Promise<'merged' | { error: string }> {
  await git(env, ['add', '-A', ...ALL], dir);
  const markers = await git(env, ['diff', '--cached', '--check'], dir);
  if (/conflict marker/i.test(markers.out)) return { error: `충돌 표시가 남아 있어요.\n${tail(markers.out)}` };
  const committed = await git(env, [...AUTHOR, 'commit', '-q', '--no-edit'], dir);
  return committed.ok ? 'merged' : { error: committed.out };
}

export async function abortMerge(env: GitEnv, dir: string): Promise<void> {
  await git(env, ['merge', '--abort'], dir);
}

export type Checks = readonly (readonly string[])[];

export async function runChecks(run: ProcessRunner, checks: Checks, dir: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; detail: string }> {
  for (const [cmd, ...args] of checks) {
    if (cmd === undefined) continue;
    if (signal?.aborted === true) return { ok: false, detail: '멈췄어요.' };
    const result = await run(cmd, args, { cwd: dir, timeoutMs: CHECK_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) }).catch((error: unknown) => ({ code: 1, stdout: '', stderr: String(error), timedOut: false }));
    if (result.code !== 0 || result.timedOut) return { ok: false, detail: `$ ${[cmd, ...args].join(' ')}\n${tail(`${result.stdout}\n${result.stderr}`.trim())}` };
  }
  return { ok: true };
}

/** Reads and removes a file the coder wrote in the worktree (the split plan), so it is never committed. */
export async function takeFile(dir: string, name: string): Promise<string | undefined> {
  const path = join(dir, name);
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text !== undefined) await rm(path, { force: true });
  return text;
}
