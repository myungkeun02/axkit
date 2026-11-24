import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { ProcessRunner } from '../../../src/core/process/types.js';
import { Autopilot, autopilotTool } from '../../../src/skills/dev-assist/autopilot.js';
import type { DevRunner } from '../../../src/skills/dev-assist/background.js';
import { devConfigSchema } from '../../../src/skills/dev-assist/config.js';
import type { DevToolDeps } from '../../../src/skills/dev-assist/deps.js';
import type { Job } from '../../../src/skills/dev-assist/types.js';
import { createTestContext, ScriptedLlm } from '../../support/context.js';

function setup(pick: string) {
  const notices: string[] = [];
  const llm = new ScriptedLlm([pick, JSON.stringify({ verdict: 'good', notes: '업로드 실패 때 다시 시도하게 바뀌었어요.' })]);
  const context = createTestContext({ now: new Date('2026-11-25T02:10:00+09:00'), llm, capabilities: { [Contracts.notifier.id]: { notify: async (notice: { text: string }) => (notices.push(notice.text), { delivered: true }) } } });
  const jobs: Job[] = [];
  const store = { all: () => jobs, get: (id: string) => jobs.find((job) => job.id === id) };
  const runner = {
    start: async (input: { repo: string; request: string }) => {
      jobs.push({ id: `job_${jobs.length + 1}`, repo: input.repo, branch: 'ax-kit/fix-upload-abc123', dir: '/w', title: input.request.split('\n')[0] ?? '', request: input.request, status: 'running', diffStat: '', createdAt: '' } as Job);
      return { status: 'started', jobId: `job_${jobs.length}`, branch: 'ax-kit/fix-upload-abc123', ahead: 0, message: '' };
    },
  } as unknown as DevRunner;
  const run: ProcessRunner = async () => ({ code: 0, stdout: 'diff --git a/x b/x', stderr: '', timedOut: false });
  const deps = { ctx: context.ctx, config: devConfigSchema.parse({ repos: [{ slug: 'betalab-lab/clipper', path: '/repos/clipper' }] }), store, run, github: { listIssues: async () => [{ number: 7, title: '업로드가 가끔 실패함' }] } } as unknown as DevToolDeps;
  const pilot = new Autopilot({ deps, runner, services: async () => [] });
  return { pilot, deps, jobs, notices, llm };
}

const PICK = JSON.stringify({ task: { title: '업로드 실패 시 다시 시도', request: 'src/upload.ts에서 R2 업로드가 실패하면 3번까지 다시 시도하게 하고 테스트를 더해 주세요.', why: '이슈 #7' } });

describe('dev teams that keep developing by themselves', () => {
  it('turns on per project, picks one task at its time, and QA tells the owner what was done', async () => {
    const { pilot, deps, jobs, notices, llm } = setup(PICK);
    const tool = autopilotTool(pilot, deps);
    expect((await tool.run({ repo: 'betalab-lab/clipper', on: true, at: '02:00' }, {} as never)).message).toContain('매일 02:00');
    await expect(tool.run({ repo: 'nope/x', on: true }, {} as never)).rejects.toThrow('dev.add_repo');

    await pilot.tick(new Date('2026-11-25T01:00:00+09:00'));
    expect(jobs).toHaveLength(0);
    await pilot.tick(new Date('2026-11-25T02:10:00+09:00'));
    expect(jobs.map((job) => job.title)).toEqual(['업로드 실패 시 다시 시도']);
    expect(String(llm.requests[0]?.messages[1]?.content)).toContain('#7 업로드가 가끔 실패함');
    // once a day
    await pilot.tick(new Date('2026-11-25T03:00:00+09:00'));
    expect(jobs).toHaveLength(1);

    const job = jobs[0] as Job;
    job.status = 'ready';
    job.tests = { passed: true } as Job['tests'];
    await pilot.finished({ status: 'ready', jobId: job.id, branch: job.branch, diffStat: '', tests: job.tests, message: '' });
    expect(notices.at(-1)).toContain('[자동 개발] betalab-lab/clipper: 업로드 실패 시 다시 시도');
    expect(notices.at(-1)).toContain('검토: 괜찮아 보여요.');
    expect(notices.at(-1)).toContain('합치거나 배포하지 않았어요');

    // the next day waits while the owner has not looked at the last result
    await pilot.tick(new Date('2026-11-26T02:10:00+09:00'));
    expect(jobs).toHaveLength(1);
    expect(notices.at(-1)).toContain('아직 안 보셨어요');
  });

  it('does nothing on a day with nothing worth doing', async () => {
    const { pilot, jobs } = setup(JSON.stringify({ task: null }));
    await pilot.set('betalab-lab/clipper', true, '02:00');
    expect(await pilot.runOnce('betalab-lab/clipper', '2026-11-25')).toContain('nothing worth doing');
    expect(jobs).toHaveLength(0);
  });
});
