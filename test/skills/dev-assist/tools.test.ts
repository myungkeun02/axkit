import { describe, expect, it } from 'vitest';
import type { DevStartOutput } from '../../../src/skills/dev-assist/background.js';
import type { DevDiscardOutput, DevOpenPrOutput } from '../../../src/skills/dev-assist/tools-pr.js';
import type { DevIssuesOutput, DevJobsOutput, DevReposOutput } from '../../../src/skills/dev-assist/tools.js';
import { FakeConfirmer } from '../../support/context.js';
import {
  FakeFetch,
  FakeRunner,
  REPO,
  TOKEN,
  fakeGit,
  issue,
  json,
  makeJob,
  setupDev,
  storedJobs,
} from './helpers.js';

const PR_URL = 'https://github.com/owner/example/pull/9';

async function readyJob() {
  const runner = fakeGit(new FakeRunner(), { changed: ['src/a.ts'], diff: '+const answer = 42;\n' });
  runner.on((cmd) => cmd === 'pnpm', { stdout: 'all green' });
  const fetchImpl = new FakeFetch();
  fetchImpl.handler = () => json({ number: 9, html_url: PR_URL });
  const confirmer = new FakeConfirmer('approved');
  const context = await setupDev({
    runner,
    fetchImpl,
    confirmer,
    repos: [{ slug: REPO.slug, path: REPO.path, test: ['pnpm', 'test'] }],
  });
  const outcome = await context.ctx.tools.execute('dev.start', {
    repo: REPO.slug,
    request: 'Fix the parser',
  });
  if (outcome.status !== 'done') throw new Error('dev.start failed');
  const ack = outcome.output as DevStartOutput;
  const started = await context.nextFinished();
  if (started.status !== 'ready' || started.jobId !== ack.jobId) throw new Error('job is not ready');
  return { context, runner, fetchImpl, confirmer, started };
}

describe('dev.repos', () => {
  it('lists the configured repositories', async () => {
    const context = await setupDev();

    const outcome = await context.ctx.tools.execute('dev.repos', {});

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' ? (outcome.output as DevReposOutput) : undefined).toMatchObject({
      count: 1,
      message: `등록된 저장소 1개: ${REPO.slug}`,
      repos: [{ slug: REPO.slug, base: 'main', tests: [] }],
    });
  });
});

describe('dev.issues', () => {
  it('lists open issues and drops pull requests', async () => {
    const fetchImpl = new FakeFetch();
    fetchImpl.handler = () => json([issue(1, 'Bug'), { ...issue(2, 'A PR'), pull_request: { url: 'x' } }]);
    const context = await setupDev({ fetchImpl });

    const outcome = await context.ctx.tools.execute('dev.issues', { repo: REPO.slug });

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' ? (outcome.output as DevIssuesOutput) : undefined).toMatchObject({
      repo: REPO.slug,
      count: 1,
      message: `${REPO.slug} 열린 이슈 1개`,
      issues: [{ number: 1, title: 'Bug' }],
    });
  });

  it('refuses an unknown repository', async () => {
    const context = await setupDev();

    const outcome = await context.ctx.tools.execute('dev.issues', { repo: 'nope/nope' });

    expect(outcome.status).toBe('failed');
  });
});

describe('dev.jobs', () => {
  it('lists recent jobs', async () => {
    const { context } = await readyJob();

    const outcome = await context.ctx.tools.execute('dev.jobs', {});

    expect(outcome.status).toBe('done');
    const output = outcome.status === 'done' ? (outcome.output as DevJobsOutput) : undefined;
    expect(output?.count).toBe(1);
    expect(output?.message).toBe('개발 작업 1개');
    expect(output?.jobs[0]).toMatchObject({ status: 'ready', tests: 'passed' });
  });
});

describe('dev.open_pr', () => {
  it('pushes the job branch and opens a draft PR after confirmation', async () => {
    const { context, runner, fetchImpl, confirmer, started } = await readyJob();

    const outcome = await context.ctx.tools.execute('dev.open_pr', { jobId: started.jobId });

    expect(outcome.status).toBe('done');
    const output = outcome.status === 'done' ? (outcome.output as DevOpenPrOutput) : undefined;
    expect(output).toMatchObject({ status: 'opened', number: 9, url: PR_URL });
    expect(confirmer.requests).toHaveLength(1);
    expect(confirmer.requests[0]?.summary).toContain('PR 초안 열기');
    expect(confirmer.requests[0]?.summary).toContain(REPO.slug);
    expect(confirmer.requests[0]?.summary).toContain('main ← ');

    const [job] = await storedJobs(context);
    const push = runner.calls.find((call) => call.args.includes('push'));
    expect(push?.args).toEqual(['-C', job?.dir, 'push', 'origin', `${started.branch}:${started.branch}`]);
    expect(push?.args).not.toContain('--force');
    expect(push?.args.join(' ')).not.toContain(TOKEN);
    expect(push?.opts.env?.GIT_CONFIG_VALUE_1).toContain('AUTHORIZATION: basic ');

    const post = fetchImpl.posts()[0];
    const body = JSON.parse(String(post?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ draft: true, head: started.branch, base: 'main', title: 'Fix the parser' });
    expect(String(body.body)).toContain('Fix the parser');
    expect(String(body.body)).toContain('Tests: passed');
    expect(String(body.body)).toContain('```\nall green\n```');
    expect(String(body.body)).toContain('Opened by ax-kit. Not merged — review and merge it yourself.');

    expect((await storedJobs(context))[0]).toMatchObject({ status: 'pr_opened', prUrl: PR_URL });
    const visible = JSON.stringify([started, output]);
    expect(visible).not.toContain(TOKEN);
  });

  it('does nothing when the owner denies the confirmation', async () => {
    const { context, runner, fetchImpl, confirmer, started } = await readyJob();
    confirmer.answer = 'denied';

    const outcome = await context.ctx.tools.execute('dev.open_pr', { jobId: started.jobId });

    expect(outcome.status).toBe('denied');
    expect(runner.calls.some((call) => call.args.includes('push'))).toBe(false);
    expect(fetchImpl.posts()).toHaveLength(0);
    expect((await storedJobs(context))[0]?.status).toBe('ready');
  });

  it('refuses a job that is not ready', async () => {
    const failed = makeJob({ id: 'job_failed', status: 'failed', error: 'no changes' });
    const context = await setupDev({ jobs: [failed] });

    const outcome = await context.ctx.tools.execute('dev.open_pr', { jobId: failed.id });

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' ? (outcome.output as DevOpenPrOutput) : undefined).toMatchObject({
      status: 'refused',
    });
    expect(context.runner.calls).toHaveLength(0);
    expect(context.fetchImpl.calls).toHaveLength(0);
  });

  it('reports a missing job', async () => {
    const context = await setupDev();

    const outcome = await context.ctx.tools.execute('dev.open_pr', { jobId: 'job_missing' });

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' ? (outcome.output as DevOpenPrOutput) : undefined).toMatchObject({
      status: 'not_found',
    });
  });
});

describe('dev.discard', () => {
  it('removes the worktree and deletes the ax-kit branch', async () => {
    const job = makeJob();
    const context = await setupDev({ jobs: [job] });

    const outcome = await context.ctx.tools.execute('dev.discard', { jobId: job.id });

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' ? (outcome.output as DevDiscardOutput) : undefined).toMatchObject({
      status: 'discarded',
    });
    expect(context.runner.calls.map((call) => call.args)).toEqual([
      ['-C', REPO.path, 'worktree', 'remove', '--force', job.dir],
      ['-C', REPO.path, 'branch', '-D', job.branch],
    ]);
    expect(await storedJobs(context)).toEqual([]);
  });

  it('never deletes a branch ax-kit did not create', async () => {
    const job = makeJob({ id: 'job_foreign', branch: 'main' });
    const context = await setupDev({ jobs: [job] });

    const outcome = await context.ctx.tools.execute('dev.discard', { jobId: job.id });

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' ? (outcome.output as DevDiscardOutput) : undefined).toMatchObject({
      status: 'refused',
    });
    expect(context.runner.calls).toHaveLength(0);
    expect(await storedJobs(context)).toHaveLength(1);
  });
});
