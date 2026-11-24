import { homedir } from 'node:os';
import { z } from 'zod';
import type { Tool } from '../../core/tools/types.js';
import { findRepo, unknownRepoError } from './config.js';
import type { DevToolDeps } from './deps.js';
import type { DevRunner, DevStartOutput } from './background.js';
import { firstLine } from './text.js';
import { jobView } from './view.js';
import type { JobView } from './view.js';

const repoInput = z.string().min(1).max(200).describe('Repository slug from dev.repos, like owner/name.');
const emptyInput = z.object({});
type EmptyInput = z.infer<typeof emptyInput>;

export interface DevReposOutput {
  count: number;
  message: string;
  repos: { slug: string; base: string; tests: string[] }[];
  /** Git projects on this Mac that are not registered yet (register one with dev.add_repo). */
  unregistered?: { name: string; path: string; hasCommits: boolean; remote?: string }[];
}

export function devReposTool(deps: DevToolDeps): Tool<EmptyInput, DevReposOutput> {
  return {
    name: 'dev.repos',
    description:
      'List the repositories the dev teams may work on (base branch, tests), and the git projects found on this Mac that ' +
      'are not registered yet. A missing one can be registered with dev.add_repo; one without commits needs a first commit.',
    input: emptyInput,
    effects: ['read'],
    async run() {
      const repos = deps.config.repos.map((repo) => ({
        slug: repo.slug,
        base: repo.base,
        tests: [...(repo.test ?? [])],
      }));
      return {
        count: repos.length,
        message:
          repos.length === 0
            ? deps.texts.reposEmpty
            : deps.texts.repos(
                repos.length,
                repos.map((repo) => repo.slug),
              ),
        repos,
        ...(deps.findProjects !== undefined ? { unregistered: await unregistered(deps) } : {}),
      };
    },
  };
}

async function unregistered(deps: DevToolDeps): Promise<NonNullable<DevReposOutput['unregistered']>> {
  const found = (await deps.findProjects?.().catch(() => [])) ?? [];
  const home = homedir();
  const known = new Set(deps.config.repos.map((repo) => repo.path.replace(home, '~')));
  return found.filter((project) => !known.has(project.path)).slice(0, 20);
}

const issuesInput = z.object({
  repo: repoInput,
  limit: z.number().int().min(1).max(30).optional().describe('Maximum issues to return (1-30, default 20).'),
});

export type DevIssuesInput = z.infer<typeof issuesInput>;

export interface DevIssuesOutput {
  repo: string;
  count: number;
  message: string;
  issues: { number: number; title: string; url: string }[];
}

export function devIssuesTool(deps: DevToolDeps): Tool<DevIssuesInput, DevIssuesOutput> {
  return {
    name: 'dev.issues',
    description: 'List open GitHub issues (pull requests excluded) for a configured repository.',
    input: issuesInput,
    effects: ['read'],
    async run(value) {
      if (findRepo(deps.config, value.repo) === undefined) throw unknownRepoError(deps.config, value.repo);
      const issues = await deps.github.listIssues(value.repo, value.limit ?? 20);
      return {
        repo: value.repo,
        count: issues.length,
        message: issues.length === 0 ? deps.texts.issuesEmpty(value.repo) : deps.texts.issues(value.repo, issues.length),
        issues: issues.map((issue) => ({ number: issue.number, title: issue.title, url: issue.url })),
      };
    },
  };
}

const startInput = z.object({
  repo: repoInput,
  request: z
    .string()
    .min(1)
    .max(2000)
    .describe('What to change, in the owner\'s words. This becomes the commit title and the PR body.'),
  issue: z.number().int().positive().optional().describe('GitHub issue number to use as context.'),
});

export type DevStartInput = z.infer<typeof startInput>;

export function devStartTool(deps: DevToolDeps, runner: DevRunner): Tool<DevStartInput, DevStartOutput> {
  return {
    name: 'dev.start',
    description:
      'Start a change in a fresh git worktree, in the background: run the coder, guard the diff, run tests and commit ' +
      'locally (it never pushes or opens a pull request). It answers right away with the job id; tell the owner it ' +
      'started and that they will be told when it is done. The result comes to the owner as a notice; dev.jobs or ' +
      'work.status show progress. A second request while one is running is queued.',
    input: startInput,
    effects: ['write'],
    describe(value) {
      return deps.texts.startDescription(value.repo, firstLine(value.request, 100));
    },
    async run(value, runCtx) {
      return runner.start(
        {
          repo: value.repo,
          request: value.request,
          ...(value.issue !== undefined ? { issue: value.issue } : {}),
        },
        runCtx.call.conversation,
      );
    },
  };
}

const resumeInput = z.object({ jobId: z.string().min(1).max(80).describe('Interrupted job id from dev.jobs.') });
export type DevResumeInput = z.infer<typeof resumeInput>;
export type DevResumeOutput = DevStartOutput | { status: 'refused' | 'not_found'; message: string };

export function devResumeTool(deps: DevToolDeps, runner: DevRunner): Tool<DevResumeInput, DevResumeOutput> {
  return {
    name: 'dev.resume',
    description:
      'Rerun a dev job that a server restart interrupted, on the same worktree (or its branch if the worktree is ' +
      'gone), in the background. Use it when the owner says to continue an interrupted job ("이어서 해 줘").',
    input: resumeInput,
    effects: ['write'],
    describe(value) {
      const job = deps.store.get(value.jobId);
      return job === undefined ? deps.texts.jobNotFound(value.jobId) : deps.texts.resumeDescription(job.repo, job.branch);
    },
    async run(value) {
      const job = deps.store.get(value.jobId);
      if (job === undefined) return { status: 'not_found', message: deps.texts.jobNotFound(value.jobId) };
      if (job.status !== 'interrupted') return { status: 'refused', message: deps.texts.notInterrupted(job.status) };
      return runner.resume(job);
    },
  };
}

export interface DevJobsOutput {
  count: number;
  message: string;
  jobs: JobView[];
}

export function devJobsTool(deps: DevToolDeps): Tool<EmptyInput, DevJobsOutput> {
  return {
    name: 'dev.jobs',
    description:
      'List recent dev jobs with their status (queued, running with its step and minutes, ready, failed, ' +
      'interrupted), test result and pull request URL.',
    input: emptyInput,
    effects: ['read'],
    async run() {
      const now = deps.ctx.clock.now();
      const jobs = deps.store.all().slice(0, 20).map((job) => jobView(job, now));
      const active = jobs.flatMap((job) =>
        job.status === 'queued' || job.status === 'running'
          ? [deps.texts.activeLine(job.title, job.status, job.phase, job.elapsedMinutes ?? 0)]
          : [],
      );
      const head = jobs.length === 0 ? deps.texts.jobsEmpty : deps.texts.jobs(jobs.length);
      return {
        count: jobs.length,
        message: active.length === 0 ? head : [head, ...active.map((line) => `· ${line}`)].join('\n'),
        jobs,
      };
    },
  };
}
