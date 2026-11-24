import { describe, expect, it } from 'vitest';
import type { DevStartOutput } from '../../../src/skills/dev-assist/background.js';
import { LlmCoder } from '../../../src/skills/dev-assist/llm-coder.js';
import type { CoderFs } from '../../../src/skills/dev-assist/workspace.js';
import { ScriptedLlm } from '../../support/context.js';
import { flush } from '../../core/helpers.js';
import { FakeRunner, REPO, fakeGit, setupDev, storedJobs } from './helpers.js';

/** coder 1200s + tests 900s + 300s for git, the default job deadline */
const DEADLINE_MS = 2400 * 1000;

async function start(context: Awaited<ReturnType<typeof setupDev>>): Promise<DevStartOutput> {
  const outcome = await context.ctx.tools.execute(
    'dev.start',
    { repo: REPO.slug, request: 'Fix the parser' },
    { grounding: [], conversation: { channelId: 'channel.app', address: 'owner' } },
  );
  if (outcome.status !== 'done') throw new Error(`dev.start: ${outcome.status}`);
  return outcome.output as DevStartOutput;
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

describe('dev job deadline', () => {
  it('stops a job whose coder ignores the signal: no commit, a terminal timed-out outcome', async () => {
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
    const ack = await start(context);
    await coding.wait;

    await context.clock.advance(DEADLINE_MS + 1000);
    const result = await context.nextFinished();
    expect(result.status).toBe('failed');
    expect(result.message).toContain('시간이 다 돼서 멈췄어요');
    expect(result.message).toContain('코드를 고치던 중');

    // the coder finishes late: nothing may be committed or marked ready
    coder.open();
    for (let i = 0; i < 5; i += 1) await flush();
    expect(runner.matching('commit')).toHaveLength(0);
    expect((await storedJobs(context))[0]).toMatchObject({ id: ack.jobId, status: 'failed' });
    expect(context.notifier.notices).toHaveLength(1);
    expect(context.notifier.notices[0]?.text).toContain('시간이 다 돼서 멈췄어요');
  });

  it('passes the deadline signal into the coder and git, and reports a timeout rather than a coder failure', async () => {
    const runner = fakeGit(new FakeRunner(), { changed: ['src/a.ts'] });
    const coding = gate();
    runner.on(
      (cmd) => cmd === 'claude',
      (_cmd, _args, opts) =>
        new Promise((resolve) => {
          coding.open();
          opts.signal?.addEventListener('abort', () => resolve({ code: 1, stderr: 'killed' }));
        }),
    );
    const context = await setupDev({ runner });
    await start(context);
    await coding.wait;

    expect(runner.matching('worktree add')[0]?.opts.signal).toBeInstanceOf(AbortSignal);
    await context.clock.advance(DEADLINE_MS + 1000);
    const result = await context.nextFinished();
    expect(result.status).toBe('failed');
    expect(result.message).toContain('시간이 다 돼서 멈췄어요');
    expect(result.message).not.toContain('coder failed');
  });
});

class FakeFs implements CoderFs {
  readonly writes: string[] = [];
  async read(): Promise<string | undefined> {
    return 'export const a = 1;';
  }
  async write(path: string): Promise<void> {
    this.writes.push(path);
  }
}

describe('LlmCoder cancellation', () => {
  it('hands the signal to the model and writes nothing once it is aborted', async () => {
    const controller = new AbortController();
    const llm = new ScriptedLlm([
      '{"files":["src/a.ts"]}',
      () => {
        controller.abort(new Error('timed out'));
        return '{"edits":[{"path":"src/a.ts","content":"export const a = 2;"}]}';
      },
    ]);
    const fs = new FakeFs();
    const runner = new FakeRunner().on((_cmd, args) => args.includes('ls-files'), { stdout: 'src/a.ts\n' });
    const coder = new LlmCoder({ llm, run: runner.run, fs });

    await expect(coder.write({ dir: '/work/job_1', instructions: 'Bump a', signal: controller.signal })).rejects.toThrow('timed out');
    expect(llm.requests.map((request) => request.signal)).toEqual([controller.signal, controller.signal]);
    expect(runner.calls[0]?.opts.signal).toBe(controller.signal);
    expect(fs.writes).toHaveLength(0);
  });
});
