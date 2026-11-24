import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProcessRunner, RunOptions } from '../../../src/core/process/types.js';
import { filesSkill } from '../../../src/skills/files/plugin.js';
import { createTestContext } from '../../support/context.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeHome(): Promise<string> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'axkit-home-')));
  dirs.push(home);
  const files: Record<string, string> = {
    'Documents/예산 계획.md': '# 예산\n내년 예산 계획',
    'Documents/report.pdf': '%PDF-1.4 fake',
    'Documents/passwords.txt': 'hunter2',
    'Documents/.env': 'KEY=1',
    'Library/Application Support/app/plan.md': 'app data',
    '.ssh/id_ed25519': 'key',
    'Desktop/binary.txt': 'a\u0000b',
    'Desktop/huge.json': 'x'.repeat(1_100_000),
  };
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(home, rel, '..'), { recursive: true });
    await writeFile(join(home, rel), body);
  }
  await symlink(join(home, '.ssh/id_ed25519'), join(home, 'Documents/innocent.txt'));
  return home;
}

function fakeRunner(lines: (home: string) => string[], home: string, calls: { cmd: string; args: readonly string[]; opts: RunOptions }[]): ProcessRunner {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, stdout: `${lines(home).join('\n')}\n`, stderr: '', timedOut: false };
  };
}

async function setup(home: string, run: ProcessRunner) {
  const context = createTestContext({ assistant: { timezone: 'Asia/Seoul' } });
  await filesSkill({ home, run }).setup(context.ctx);
  return context;
}

describe('files.find', () => {
  it('runs mdfind inside home through the runner and drops excluded paths', async () => {
    const home = await makeHome();
    const calls: { cmd: string; args: readonly string[]; opts: RunOptions }[] = [];
    const run = fakeRunner(
      (h) => [
        join(h, 'Documents/예산 계획.md'),
        join(h, 'Documents/report.pdf'),
        join(h, 'Documents/passwords.txt'),
        join(h, 'Documents/.env'),
        join(h, 'Library/Application Support/app/plan.md'),
        join(h, '.ssh/id_ed25519'),
        join(h, 'Documents/innocent.txt'),
        join(h, 'Documents'),
        '/etc/hosts',
        'not a path',
        join(h, 'Documents/missing.md'),
      ],
      home,
      calls,
    );
    const { ctx } = await setup(home, run);

    const outcome = await ctx.tools.execute('files.find', { query: '계획' });
    expect(calls).toEqual([{ cmd: 'mdfind', args: ['-onlyin', home, '-name', '계획'], opts: { timeoutMs: 15_000 } }]);
    expect(outcome.status).toBe('done');
    if (outcome.status !== 'done') return;
    expect(outcome.output).toEqual([
      { name: '예산 계획.md', path: '~/Documents/예산 계획.md', size: expect.any(Number), modifiedAt: expect.stringMatching(/^\d{4}-\d\d-\d\d \d\d:\d\d$/) },
      { name: 'report.pdf', path: '~/Documents/report.pdf', size: 13, modifiedAt: expect.any(String) },
    ]);

    await ctx.tools.execute('files.find', { query: '예산', kind: 'content', limit: 1 });
    expect(calls[1]?.args).toEqual(['-onlyin', home, '예산']);
  });

  it('caps results at 20 and the schema refuses more', async () => {
    const home = await makeHome();
    for (let n = 0; n < 30; n += 1) await writeFile(join(home, 'Documents', `note-${n}.md`), 'n');
    const run = fakeRunner((h) => Array.from({ length: 30 }, (_, n) => join(h, 'Documents', `note-${n}.md`)), home, []);
    const { ctx } = await setup(home, run);
    const outcome = await ctx.tools.execute('files.find', { query: 'note', limit: 20 });
    expect(outcome.status === 'done' && outcome.output).toHaveLength(20);
    expect((await ctx.tools.execute('files.find', { query: 'note', limit: 50 })).status).toBe('invalid_input');
  });

  it('answers plainly when Spotlight cannot run', async () => {
    const home = await makeHome();
    const { ctx } = await setup(home, async () => {
      throw new Error('ENOENT');
    });
    expect(await ctx.tools.execute('files.find', { query: 'x' })).toEqual({ status: 'failed', error: '이 맥에서 Spotlight 검색을 쓸 수 없어요.' });
    const failing = await setup(home, async () => ({ code: 1, stdout: '', stderr: 'x', timedOut: false }));
    expect(await failing.ctx.tools.execute('files.find', { query: 'x' })).toMatchObject({ status: 'failed' });
  });
});

describe('files.read on a found path', () => {
  it('reads a text file under home and refuses excluded, binary, large and outside paths', async () => {
    const home = await makeHome();
    const { ctx } = await setup(home, fakeRunner(() => [], home, []));
    const read = (id: string) => ctx.tools.execute('files.read', { source: 'home', id });

    const ok = await read('~/Documents/예산 계획.md');
    expect(ok).toMatchObject({ status: 'done', output: { text: '# 예산\n내년 예산 계획' } });
    expect(await read(join(home, 'Documents/예산 계획.md'))).toMatchObject({ status: 'done' });

    expect(await read('~/Documents/passwords.txt')).toMatchObject({ status: 'failed', error: expect.stringContaining('비밀번호') });
    expect(await read('~/Documents/.env')).toMatchObject({ status: 'failed' });
    expect(await read('~/Library/Application Support/app/plan.md')).toMatchObject({ status: 'failed' });
    expect(await read('~/Documents/innocent.txt')).toMatchObject({ status: 'failed', error: expect.stringContaining('비밀번호') });
    expect(await read('~/Documents/report.pdf')).toMatchObject({ status: 'failed', error: '이 종류의 파일은 다룰 수 없어요.' });
    expect(await read('~/Desktop/binary.txt')).toMatchObject({ status: 'failed', error: expect.stringContaining('글자로 된') });
    expect(await read('~/Desktop/huge.json')).toMatchObject({ status: 'failed', error: '파일이 너무 커요.' });
    expect(await read('/etc/hosts')).toMatchObject({ status: 'failed', error: '홈 폴더 안의 파일만 열 수 있어요.' });
    expect(await read('~/../../etc/hosts')).toMatchObject({ status: 'failed' });
  });
});
