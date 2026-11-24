import { randomUUID } from 'node:crypto';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunOptions } from '../../core/process/types.js';
import type { CoderResult } from './coder.js';
import type { RepoConfig } from './config.js';
import type { DevToolDeps } from './deps.js';
import type { Git } from './git.js';
import { newBranchName } from './git.js';
import type { GitHubIssue } from './github.js';
import { findSecretKinds, mask, protectedPaths } from './guard.js';
import { testsState } from './locale.js';
import { buildTaskPrompt } from './prompt.js';
import { errorMessage, firstLine, tail } from './text.js';
import type { Job, JobOrigin, JobTests } from './types.js';
import { MAX_REQUEST_CHARS, MAX_TEST_TAIL_CHARS } from './types.js';

export interface StartTaskInput {
  repo: string;
  request: string;
  issue?: number;
}

/** How a job ended; the owner hears `message` through the notifier. */
export type FinishedTask =
  | {
      status: 'ready';
      jobId: string;
      branch: string;
      diffStat: string;
      tests: JobTests | undefined;
      message: string;
    }
  | { status: 'failed'; jobId: string; branch: string; error: string; message: string };

const MAX_TITLE_CHARS = 120;
const MAX_STORED_ERROR_CHARS = 1000;

export function titleOf(request: string, issueTitle: string | undefined): string {
  const title = issueTitle === undefined ? firstLine(request, MAX_TITLE_CHARS) : issueTitle.trim();
  const clipped = title.slice(0, MAX_TITLE_CHARS).trim();
  return clipped === '' ? 'task' : clipped;
}

export function commitMessage(title: string, issue: number | undefined): string {
  const base = `${title}\n\nRequested via ax-kit`;
  return issue === undefined ? base : `${base}\n\nRefs #${issue}`;
}

async function runTests(
  deps: DevToolDeps,
  repo: RepoConfig,
  dir: string,
  signal: AbortSignal | undefined,
): Promise<JobTests | undefined> {
  const argv = repo.test;
  if (argv === undefined || argv.length === 0) return undefined;
  const [cmd, ...args] = argv;
  if (cmd === undefined) return undefined;
  const options: RunOptions = {
    cwd: dir,
    timeoutMs: repo.testTimeoutSeconds * 1000,
    ...(signal !== undefined ? { signal } : {}),
  };
  try {
    const result = await deps.run(cmd, args, options);
    const text = mask(tail(`${result.stdout}\n${result.stderr}`.trim(), MAX_TEST_TAIL_CHARS));
    return { passed: result.code === 0 && !result.timedOut, tail: text };
  } catch (error) {
    return { passed: false, tail: mask(tail(errorMessage(error), MAX_TEST_TAIL_CHARS)) };
  }
}

/** A new job record, saved before anything touches git, so a restart knows it was cut off. */
export function newJob(deps: DevToolDeps, input: StartTaskInput, origin: JobOrigin | undefined): Job {
  const createdAt = deps.ctx.clock.now().toISOString();
  const title = titleOf(input.request, undefined);
  const jobId = `job_${randomUUID().slice(0, 8)}`;
  return {
    id: jobId,
    repo: input.repo,
    branch: newBranchName(title),
    dir: join(deps.workDir, jobId),
    title,
    request: input.request.trim().slice(0, MAX_REQUEST_CHARS),
    ...(input.issue !== undefined ? { issue: input.issue } : {}),
    status: 'queued',
    phase: 'preparing',
    diffStat: '',
    createdAt,
    updatedAt: createdAt,
    ...(origin !== undefined ? { origin } : {}),
  };
}

export interface JobHooks {
  /** Saves the job at a checkpoint and returns the saved copy. */
  checkpoint(job: Job): Promise<Job>;
  signal?: AbortSignal;
  /** Reuse the job's worktree or branch when it is still there (resuming after a restart). */
  resume?: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function prepareWorktree(deps: DevToolDeps, git: Git, repo: RepoConfig, job: Job, resume: boolean): Promise<void> {
  await mkdir(deps.workDir, { recursive: true, mode: 0o700 });
  if (resume && (await exists(job.dir))) return;
  if (resume && (await git.branchExists(repo.path, job.branch))) {
    await git.worktreeAttach(repo.path, job.dir, job.branch);
    return;
  }
  await git.worktreeAdd(repo.path, job.dir, job.branch, repo.base);
}

interface Performed {
  job: Job;
  result: FinishedTask;
}

/**
 * Runs a stored job: worktree, coder, guard, tests and a local commit, saving a checkpoint at each step.
 * It never pushes. Returns the finished job (ready or failed), already saved. Once `signal` is aborted it throws the
 * abort reason instead of failing or committing, so the caller decides between "timed out" and "shutting down".
 */
export async function performJob(deps: DevToolDeps, repo: RepoConfig, stored: Job, hooks: JobHooks): Promise<Performed> {
  const signal = hooks.signal;
  const resume = hooks.resume === true;
  const git = deps.git.withSignal(signal);
  let job = await hooks.checkpoint({ ...stored, status: 'running', phase: 'preparing', error: undefined });

  const fail = async (reason: string): Promise<Performed> => {
    // an error caused by the cancellation is the cancellation, not a failure of the job
    signal?.throwIfAborted();
    const error = mask(reason).slice(0, MAX_STORED_ERROR_CHARS);
    job = await hooks.checkpoint({ ...job, status: 'failed', error });
    return { job, result: { status: 'failed', jobId: job.id, branch: job.branch, error, message: deps.texts.startFailed(error) } };
  };

  let issue: GitHubIssue | undefined;
  try {
    issue = job.issue === undefined ? undefined : await deps.github.getIssue(job.repo, job.issue);
  } catch (error) {
    return fail(errorMessage(error));
  }
  if (issue !== undefined && !resume) {
    // the issue title names the job and its branch; nothing has used the branch yet
    const title = titleOf(job.request, issue.title);
    job = await hooks.checkpoint({ ...job, title, branch: newBranchName(title) });
  }

  try {
    await prepareWorktree(deps, git, repo, job, resume);
  } catch (error) {
    return fail(errorMessage(error));
  }
  job = await hooks.checkpoint({ ...job, phase: 'worktree' });

  let coderResult: CoderResult;
  job = await hooks.checkpoint({ ...job, phase: 'coding' });
  try {
    coderResult = await deps.coder.write({
      dir: job.dir,
      instructions: buildTaskPrompt({
        repo: job.repo,
        request: job.request,
        ...(issue !== undefined ? { issue } : {}),
        ...(repo.test !== undefined ? { tests: repo.test } : {}),
      }),
      ...(signal !== undefined ? { signal } : {}),
    });
  } catch (error) {
    return fail(`coder failed: ${errorMessage(error)}`);
  }
  if (!coderResult.ok) return fail(`coder failed: ${tail(coderResult.log, 500)}`);

  let diff: string;
  let diffStat: string;
  try {
    const changed = await git.changedFiles(job.dir);
    if (changed.length === 0) return fail(deps.texts.noChanges);
    const blocked = protectedPaths(changed);
    if (blocked.length > 0) return fail(deps.texts.protectedChanged(blocked));
    await git.stageAll(job.dir);
    diff = await git.diff(job.dir);
    diffStat = await git.diffStat(job.dir);
  } catch (error) {
    return fail(errorMessage(error));
  }

  const secretKinds = findSecretKinds(diff);
  if (secretKinds.length > 0) return fail(deps.texts.secretFound(secretKinds));

  job = await hooks.checkpoint({ ...job, phase: 'testing' });
  const tests = await runTests(deps, repo, job.dir, signal);
  job = await hooks.checkpoint({ ...job, phase: 'committing' });
  try {
    signal?.throwIfAborted();
    await git.commitAll(job.dir, commitMessage(job.title, job.issue));
  } catch (error) {
    return fail(`commit failed: ${errorMessage(error)}`);
  }

  job = await hooks.checkpoint({
    ...job,
    status: 'ready',
    diffStat,
    phase: undefined,
    ...(tests !== undefined ? { tests } : {}),
  });
  const message = deps.texts.startReady(job.branch, testsState(tests));
  return { job, result: { status: 'ready', jobId: job.id, branch: job.branch, diffStat, tests, message } };
}
