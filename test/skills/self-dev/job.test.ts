import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { nodeProcessRunner } from '../../../src/core/process/node-runner.js';
import type { Coder } from '../../../src/skills/dev-assist/coder.js';
import { readReport, runSelfDev } from '../../../src/skills/self-dev/job.js';

async function repo(): Promise<{ root: string; work: string }> {
  const base = await mkdtemp(join(tmpdir(), 'axk-self-'));
  const root = join(base, 'ax-kit');
  await mkdir(root);
  const sh = (...args: string[]) => execFileSync('git', args, { cwd: root });
  sh('init', '-q', '-b', 'main');
  await writeFile(join(root, 'a.txt'), 'one\n');
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, '.gitignore'), 'node_modules\n');
  sh('add', '-A');
  sh('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return { root, work: join(base, 'work') };
}

const writes = (text: string, log = '요약: a.txt를 바꿨어요\n사람이 할 일: 없음'): Coder => ({
  write: async ({ dir }) => {
    await writeFile(join(dir, 'a.txt'), text);
    return { ok: true, log };
  },
});

describe('runSelfDev', () => {
  it('codes in a worktree, checks, commits and fast-forwards the running checkout', async () => {
    const { root, work } = await repo();
    const lines: string[] = [];
    const outcome = await runSelfDev({ root, workDir: work, run: nodeProcessRunner, coder: writes('two\n'), checks: [['true']], boot: false, progress: (line) => lines.push(line) }, 'sd-1', 'a.txt를 two로');
    expect(outcome).toMatchObject({ status: 'applied', summary: 'a.txt를 바꿨어요', needs: '' });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('two\n');
    expect(execFileSync('git', ['branch', '--list', 'ax-self/*'], { cwd: root }).toString().trim()).toBe('');
    expect(lines[0]).toContain('고치는 중');
  });

  it('feeds failed checks back to the coder and leaves the running code alone when they still fail', async () => {
    const { root, work } = await repo();
    let rounds = 0;
    const coder: Coder = { write: async ({ dir, instructions }) => (rounds++, await writeFile(join(dir, 'a.txt'), 'broken\n'), { ok: true, log: instructions.includes('checks failed') ? 'tried' : 'first' }) };
    const outcome = await runSelfDev({ root, workDir: work, run: nodeProcessRunner, coder, checks: [['false']] }, 'sd-2', '고쳐줘');
    expect(outcome).toMatchObject({ status: 'failed', stage: 'checks', branch: 'ax-self/sd-2' });
    expect(rounds).toBe(3);
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('keeps what was done in front of what a fix round fixed', async () => {
    const { root, work } = await repo();
    const marker = join(work, '..', 'checked-once');
    let round = 0;
    const coder: Coder = { write: async ({ dir }) => (round++, await writeFile(join(dir, 'a.txt'), 'two\n'), { ok: true, log: round === 1 ? '요약: a.txt를 바꿨어요\n사람이 할 일: 없음' : '요약: 테스트를 고쳤어요\n사람이 할 일: 없음' }) };
    const outcome = await runSelfDev({ root, workDir: work, run: nodeProcessRunner, coder, checks: [['sh', '-c', `test -f ${marker} || { touch ${marker}; exit 1; }`]], boot: false }, 'sd-6', 'x');
    expect(outcome).toMatchObject({ status: 'applied', summary: 'a.txt를 바꿨어요\n· 검사 고침: 테스트를 고쳤어요' });
  });

  it('does not apply over the owner’s own uncommitted change', async () => {
    const { root, work } = await repo();
    await writeFile(join(root, 'a.txt'), 'mine\n');
    const outcome = await runSelfDev({ root, workDir: work, run: nodeProcessRunner, coder: writes('two\n'), checks: [['true']], boot: false }, 'sd-3', 'x');
    expect(outcome).toMatchObject({ status: 'failed', stage: 'apply' });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('mine\n');
  });

  it('never commits the borrowed node_modules link', async () => {
    const { root, work } = await repo();
    // the real checkout ignores "node_modules/" (a folder rule that misses a link), as this repo once did
    await writeFile(join(root, '.gitignore'), 'node_modules/\n');
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', 'folder rule'], { cwd: root });
    const outcome = await runSelfDev({ root, workDir: work, run: nodeProcessRunner, coder: writes('two\n'), checks: [['true']], boot: false }, 'sd-4', 'x');
    expect(outcome.status).toBe('applied');
    expect(execFileSync('git', ['ls-files'], { cwd: root }).toString()).not.toContain('node_modules');
  });

  it('goes back and does not restart when the new code does not start', async () => {
    const { root, work } = await repo();
    const run: typeof nodeProcessRunner = async (cmd, args, opts) => (cmd === process.execPath ? { code: 1, stdout: '', stderr: 'SyntaxError', timedOut: false } : await nodeProcessRunner(cmd, args, opts));
    const outcome = await runSelfDev({ root, workDir: work, run, coder: writes('two\n'), checks: [['true']] }, 'sd-5', 'x');
    expect(outcome).toMatchObject({ status: 'failed', stage: 'apply' });
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('reads the summary and what the owner must do', () => {
    expect(readReport('...\n요약: 알림을 고쳤어요\n사람이 할 일: ax-kit connect google 실행')).toEqual({ summary: '알림을 고쳤어요', needs: 'ax-kit connect google 실행' });
    expect(readReport('요약: 됐어요\n사람이 할 일: 없음').needs).toBe('');
  });
});
