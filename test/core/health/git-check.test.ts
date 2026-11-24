import { describe, expect, it } from 'vitest';
import type { HealthTexts } from '../../../src/core/health/builtin.js';
import { uncommittedCodeCheck } from '../../../src/core/health/git-check.js';
import type { ProcessRunner, RunOptions } from '../../../src/core/process/types.js';

const NOW = new Date('2026-11-17T09:00:00.000Z');

const TEXTS: HealthTexts = {
  switchLongPaused: (feature, days, reason) => `${feature}:${days}:${reason}`,
  switchAutoPaused: (feature, reason) => `${feature}:${reason}`,
  switchNone: () => 'none',
  noticeBudget: (days, max) => `${days}:${max}`,
  noticeLoud: (kind, count) => `${kind}:${count}`,
  knowledgeReview: (count) => `${count}`,
  knowledgeStale: (count) => `${count}`,
  notGitCheckout: () => 'not-git',
  codeCommitted: () => 'clean',
  uncommittedChanges: (count) => `dirty:${count}`,
  uncommittedFix: () => 'fix',
};

interface Call {
  cmd: string;
  args: readonly string[];
  opts: RunOptions;
}

function runner(code: number, stdout: string, calls: Call[]): ProcessRunner {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code, stdout, stderr: '', timedOut: false };
  };
}

describe('uncommittedCodeCheck', () => {
  it('passes when the working tree is clean and asks git about the code directory', async () => {
    const calls: Call[] = [];
    const check = uncommittedCodeCheck({ codeDir: '/code', run: runner(0, '', calls), texts: TEXTS });

    expect(check.id).toBe('ops.uncommitted');
    expect(await check.run(NOW)).toEqual([{ id: 'ops.uncommitted', area: 'ops', ok: true, line: 'clean' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toBe('git');
    expect(calls[0]?.args).toEqual(['-C', '/code', 'status', '--porcelain']);
    expect(calls[0]?.opts.timeoutMs).toBeGreaterThan(0);
  });

  it('fails with the number of changed files and a fix line', async () => {
    const calls: Call[] = [];
    const check = uncommittedCodeCheck({ codeDir: '/code', run: runner(0, ' M a.ts\n?? b.ts\n\n', calls), texts: TEXTS });

    expect(await check.run(NOW)).toEqual([
      { id: 'ops.uncommitted', area: 'ops', ok: false, line: 'dirty:2', fix: 'fix' },
    ]);
  });

  it('passes when the directory is not a git checkout', async () => {
    const calls: Call[] = [];
    const check = uncommittedCodeCheck({ codeDir: '/code', run: runner(128, '', calls), texts: TEXTS });

    expect(await check.run(NOW)).toEqual([{ id: 'ops.uncommitted', area: 'ops', ok: true, line: 'not-git' }]);
  });
});
