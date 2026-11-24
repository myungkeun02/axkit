import { z } from 'zod';
import type { Tool } from '../../core/tools/types.js';
import { findRepo, unknownRepoError } from './config.js';
import type { DevToolDeps } from './deps.js';
import { isManagedBranch } from './git.js';
import { GITHUB_TOKEN_MISSING } from './github.js';
import { testsState } from './locale.js';
import type { Job } from './types.js';
import { isActiveJob } from './types.js';

export function pullRequestBody(job: Job): string {
  const lines = [job.request, ''];
  if (job.issue !== undefined) lines.push(`Refs #${job.issue}`, '');
  const tests = job.tests === undefined ? 'not run' : job.tests.passed ? 'passed' : 'failed';
  lines.push(`Tests: ${tests}`);
  lines.push('```');
  lines.push(job.tests?.tail === undefined || job.tests.tail === '' ? 'no test output' : job.tests.tail);
  lines.push('```', '', 'Opened by ax-kit. Not merged — review and merge it yourself.');
  return lines.join('\n');
}

const openInput = z.object({
  jobId: z.string().min(1).max(80).describe('Job id from dev.jobs.'),
  title: z.string().min(1).max(200).optional().describe('Pull request title; defaults to the job title.'),
});

export type DevOpenPrInput = z.infer<typeof openInput>;

export type DevOpenPrOutput =
  | { status: 'opened'; number: number; url: string; message: string }
  | { status: 'refused'; message: string }
  | { status: 'not_found'; message: string };

export function devOpenPrTool(deps: DevToolDeps): Tool<DevOpenPrInput, DevOpenPrOutput> {
  return {
    name: 'dev.open_pr',
    description:
      'Push a ready job branch and open a DRAFT pull request. It never merges; the owner reviews and merges.',
    input: openInput,
    effects: ['send'],
    describe(value) {
      const job = deps.store.get(value.jobId);
      if (job === undefined) return deps.texts.prMissing(value.jobId);
      const base = findRepo(deps.config, job.repo)?.base ?? 'main';
      return deps.texts.prDescription(
        job.repo,
        base,
        job.branch,
        value.title ?? job.title,
        job.diffStat,
        testsState(job.tests),
      );
    },
    async run(value) {
      const job = deps.store.get(value.jobId);
      if (job === undefined) return { status: 'not_found', message: deps.texts.jobNotFound(value.jobId) };
      if (job.status !== 'ready') return { status: 'refused', message: deps.texts.jobNotReady(job.status) };

      const repo = findRepo(deps.config, job.repo);
      if (repo === undefined) throw unknownRepoError(deps.config, job.repo);
      const token = await deps.ctx.secrets.get('github.token');
      if (token === undefined || token.trim() === '') throw new Error(GITHUB_TOKEN_MISSING);

      await deps.git.push(job.dir, job.branch, token);
      const pull = await deps.github.createPullRequest({
        slug: job.repo,
        head: job.branch,
        base: repo.base,
        title: value.title ?? job.title,
        body: pullRequestBody(job),
      });
      await deps.store.update({ ...job, status: 'pr_opened', prUrl: pull.url });
      return { status: 'opened', number: pull.number, url: pull.url, message: deps.texts.prOpened(pull.url) };
    },
  };
}

const discardInput = z.object({
  jobId: z.string().min(1).max(80).describe('Job id from dev.jobs.'),
});

export type DevDiscardInput = z.infer<typeof discardInput>;

export type DevDiscardOutput =
  | { status: 'discarded'; message: string }
  | { status: 'refused'; message: string }
  | { status: 'not_found'; message: string };

export function devDiscardTool(deps: DevToolDeps): Tool<DevDiscardInput, DevDiscardOutput> {
  return {
    name: 'dev.discard',
    description: 'Remove a job worktree and its ax-kit branch from the local clone, and forget the job.',
    input: discardInput,
    effects: ['delete'],
    describe(value) {
      const job = deps.store.get(value.jobId);
      return job === undefined
        ? deps.texts.discardMissing(value.jobId)
        : deps.texts.discardDescription(job.branch, job.dir);
    },
    async run(value) {
      const job = deps.store.get(value.jobId);
      if (job === undefined) return { status: 'not_found', message: deps.texts.jobNotFound(value.jobId) };
      if (isActiveJob(job)) return { status: 'refused', message: deps.texts.jobBusy };
      if (!isManagedBranch(job.branch)) return { status: 'refused', message: deps.texts.notManaged(job.branch) };

      const repo = findRepo(deps.config, job.repo);
      if (repo === undefined) throw unknownRepoError(deps.config, job.repo);
      await deps.git.worktreeRemove(repo.path, job.dir, job.branch);
      await deps.store.remove(job.id);
      return { status: 'discarded', message: deps.texts.discarded(job.branch) };
    },
  };
}

const keepInput = z.object({ jobId: z.string().min(1).max(40).describe('The job id from dev.jobs.') });

/**
 * Tool "dev.keep": the owner looked at a finished job and keeps it on its branch without a pull request (a project
 * only on this Mac has no PR to open). The branch stays for the owner to merge; the job stops waiting for a decision.
 */
export function devKeepTool(deps: DevToolDeps): Tool<z.infer<typeof keepInput>, { status: 'kept' | 'not_found' | 'refused'; message: string }> {
  return {
    name: 'dev.keep',
    description: 'Mark a finished dev job as looked at and kept on its branch (no pull request), so the next work can go on. The branch is not merged or deleted.',
    input: keepInput,
    effects: ['write'],
    async run(value) {
      const job = deps.store.get(value.jobId);
      if (job === undefined) return { status: 'not_found', message: deps.texts.jobNotFound(value.jobId) };
      if (job.status !== 'ready') return { status: 'refused', message: deps.texts.jobBusy };
      await deps.store.update({ ...job, kept: true });
      return { status: 'kept', message: `브랜치 ${job.branch}에 남겨 뒀어요. 합치려면 그 프로젝트 폴더에서 이 브랜치를 합치면 돼요.` };
    },
  };
}
