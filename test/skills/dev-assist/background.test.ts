import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { DevStartOutput } from '../../../src/skills/dev-assist/background.js';
import type { DevJobsOutput, DevResumeOutput } from '../../../src/skills/dev-assist/tools.js';
import type { Job } from '../../../src/skills/dev-assist/types.js';
import { KvWorkBoard } from '../../../src/skills/work/board.js';
import { MapKeyValueStore, flush } from '../../core/helpers.js';
import { FakeRunner, NOW, REPO, fakeGit, makeJob, setupDev, storedJobs } from './helpers.js';

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

async function start(context: Awaited<ReturnType<typeof setupDev>>, request: string): Promise<DevStartOutput> {
  const outcome = await context.ctx.tools.execute(
    'dev.start',
    { repo: REPO.slug, request },
    { grounding: [], conversation: { channelId: 'channel.app', address: 'owner' } },
  );
  if (outcome.status !== 'done') throw new Error(`dev.start: ${outcome.status}`);
  return outcome.output as DevStartOutput;
}

describe('dev.start in the background', () => {
  it('saves the job as running before the worktree, answers right away and reports through the notifier', async () => {
    const runner = fakeGit(new FakeRunner(), { changed: ['src/a.ts'], diff: '+const answer = 42;\n' });
    const seenAtWorktree: (Job | undefined)[] = [];
    const context = await setupDev({ runner });
    runner.on(
      (_cmd, args) => args.includes('worktree'),
      async () => {
        seenAtWorktree.push((await storedJobs(context))[0]);
        return { code: 0 };
      },
    );

    const ack = await start(context, 'Fix the parser');

    expect(ack.status).toBe('started');
    expect(ack.message).toBe(`시작했어요. 끝나면 알려드릴게요. (작업 ${ack.jobId})`);
    const result = await context.nextFinished();
    expect(result.status).toBe('ready');
    expect(seenAtWorktree[0]).toMatchObject({ id: ack.jobId, status: 'running', phase: 'preparing', origin: { channelId: 'channel.app' } });
    expect(context.notifier.notices).toHaveLength(1);
    expect(context.notifier.notices[0]).toMatchObject({ kind: 'dev.job', urgent: true, dedupeKey: `${ack.jobId}:ready` });
    expect(context.notifier.notices[0]?.text).toContain("개발 작업 'Fix the parser': 작업을 준비했어요.");
    expect((await storedJobs(context))[0]).toMatchObject({ status: 'ready' });
    expect((await storedJobs(context))[0]?.phase).toBeUndefined();
  });

  it('shows a running job with its step and minutes, and queues a second request kindly', async () => {
    const runner = fakeGit(new FakeRunner(), { changed: ['src/a.ts'], diff: '+const answer = 42;\n' });
    const coder = gate();
    const coding = gate();
    let coderCalls = 0;
    runner.on(
      (cmd) => cmd === 'claude',
      async () => {
        coderCalls += 1;
        coding.open();
        if (coderCalls === 1) await coder.wait;
        return { code: 0 };
      },
    );
    const context = await setupDev({ runner });

    const first = await start(context, 'First change');
    await coding.wait;
    await context.clock.advance(12 * 60_000);
    const second = await start(context, 'Second change');

    expect(second.status).toBe('queued');
    expect(second.message).toContain("지금 'First change' 작업을 하고 있어서 그다음 순서로 해 둘게요");
    const listing = await context.ctx.tools.execute('dev.jobs', {});
    const jobs = listing.status === 'done' ? (listing.output as DevJobsOutput) : undefined;
    expect(jobs?.jobs.find((job) => job.id === first.jobId)).toMatchObject({ status: 'running', phase: 'coding', elapsedMinutes: 12 });
    expect(jobs?.jobs.find((job) => job.id === second.jobId)).toMatchObject({ status: 'queued' });
    expect(jobs?.message).toContain('· First change: 코드 고치는 중, 12분째');
    expect(jobs?.message).toContain('· Second change: 순서 기다리는 중');

    coder.open();
    expect((await context.nextFinished()).jobId).toBe(first.jobId);
    expect((await context.nextFinished()).jobId).toBe(second.jobId);
    expect((await storedJobs(context)).map((job) => job.status)).toEqual(['ready', 'ready']);
    expect(context.notifier.notices.map((notice) => notice.kind)).toEqual(['dev.job', 'dev.job']);
  });

  it('registers each job in the work list', async () => {
    const runner = fakeGit(new FakeRunner(), { changed: ['src/a.ts'], diff: '+const answer = 42;\n' });
    const board = new KvWorkBoard(new MapKeyValueStore(), () => NOW);
    const context = await setupDev({ runner, capabilities: { [Contracts.workInProgress.id]: board } });

    const ack = await start(context, 'Fix the parser');
    await context.nextFinished();

    expect(await board.get(`dev:${ack.jobId}`)).toMatchObject({
      kind: 'dev',
      title: `${REPO.slug}: Fix the parser`,
      status: 'done',
      origin: { channelId: 'channel.app', address: 'owner' },
    });
  });
});

describe('after a restart', () => {
  it('marks a job left running as interrupted and tells the owner once', async () => {
    const running = makeJob({ id: 'job_cut', status: 'running', phase: 'coding', branch: 'ax-kit/fix-the-thing-abc123' });
    const context = await setupDev({ jobs: [running] });

    expect((await storedJobs(context))[0]).toMatchObject({ status: 'interrupted', told: false });
    await context.bus.emit('app.started', { at: NOW });
    await context.bus.emit('app.started', { at: NOW });

    expect(context.notifier.notices).toHaveLength(1);
    expect(context.notifier.notices[0]?.kind).toBe('work.interrupted');
    expect(context.notifier.notices[0]?.text).toContain("개발 작업 'Fix the thing'이(가) 중간에 멈췄어요");
    expect(context.notifier.notices[0]?.text).toContain('이어서 해 줘');
    expect((await storedJobs(context))[0]?.told).toBe(true);
  });

  it('resumes an interrupted job on its own branch when the worktree is gone', async () => {
    const runner = fakeGit(new FakeRunner(), { changed: ['src/a.ts'], diff: '+const answer = 42;\n' });
    const job = makeJob({ id: 'job_cut', status: 'interrupted', told: true, dir: '/nonexistent/ax-kit/job_cut' });
    const context = await setupDev({ runner, jobs: [job] });

    const outcome = await context.ctx.tools.execute('dev.resume', { jobId: job.id });
    const ack = outcome.status === 'done' ? (outcome.output as DevResumeOutput) : undefined;
    expect(ack).toMatchObject({ status: 'started', jobId: job.id, branch: job.branch });
    const result = await context.nextFinished();

    expect(result).toMatchObject({ status: 'ready', branch: job.branch });
    const add = runner.calls.find((call) => call.args.includes('worktree'));
    expect(add?.args).toEqual(['-C', REPO.path, 'worktree', 'add', job.dir, job.branch]);
  });

  it('refuses to resume a job that was not interrupted', async () => {
    const context = await setupDev({ jobs: [makeJob()] });

    const outcome = await context.ctx.tools.execute('dev.resume', { jobId: 'job_seed' });

    expect(outcome.status === 'done' ? outcome.output : undefined).toMatchObject({ status: 'refused' });
    expect(context.runner.calls).toHaveLength(0);
  });

  it('leaves a job cut off by shutdown as running, so the next start reports it', async () => {
    const runner = fakeGit(new FakeRunner(), { changed: ['src/a.ts'] });
    const coder = gate();
    const coding = gate();
    runner.on(
      (cmd) => cmd === 'claude',
      async () => {
        coding.open();
        await coder.wait;
        return { code: 1, stderr: 'killed' };
      },
    );
    const context = await setupDev({ runner });

    await start(context, 'Fix the parser');
    await coding.wait;
    await context.bus.emit('app.stopping', { reason: 'test' });
    coder.open();
    await flush();
    await flush();

    expect((await storedJobs(context))[0]).toMatchObject({ status: 'running', phase: 'coding' });
    expect(context.notifier.notices).toHaveLength(0);
  });
});

describe('dev.discard', () => {
  it('does not delete a job that is still running', async () => {
    const runner = fakeGit(new FakeRunner(), { changed: ['src/a.ts'], diff: '+const answer = 42;\n' });
    const coder = gate();
    const coding = gate();
    runner.on(
      (cmd) => cmd === 'claude',
      async () => {
        coding.open();
        await coder.wait;
        return { code: 0 };
      },
    );
    const context = await setupDev({ runner });
    const ack = await start(context, 'Fix the parser');
    await coding.wait;

    const outcome = await context.ctx.tools.execute('dev.discard', { jobId: ack.jobId });

    expect(outcome.status === 'done' ? outcome.output : undefined).toMatchObject({ status: 'refused' });
    expect(runner.calls.some((call) => call.args.includes('remove'))).toBe(false);
    coder.open();
    await context.nextFinished();
  });
});
