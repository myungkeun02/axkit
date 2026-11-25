import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BEFORE_UPDATE_BRANCH, updateCommand } from '../../src/cli/update.js';

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
const dirs: string[] = [];
const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, ...ID, ...args], { encoding: 'utf8' }).trim();

/** An "upstream" repo and an install cloned from it, like a Mac that ran install.sh. */
async function repos(): Promise<{ up: string; mac: string }> {
  const root = await mkdtemp(join(tmpdir(), 'axk-update-'));
  dirs.push(root);
  const up = join(root, 'up');
  await mkdir(join(up, 'bin'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', up]);
  await writeFile(join(up, 'bin', 'ax-kit.mjs'), 'process.exit(0);\n');
  await writeFile(join(up, 'a.txt'), 'one\ntwo\nthree\n');
  await writeFile(join(up, 'b.txt'), 'b\n');
  git(up, 'add', '-A');
  git(up, 'commit', '-q', '-m', 'start');
  const mac = join(root, 'mac');
  execFileSync('git', ['clone', '-q', up, mac]);
  return { up, mac };
}

async function upstreamChange(up: string, file: string, text: string): Promise<void> {
  await writeFile(join(up, file), text);
  git(up, 'commit', '-q', '-am', `change ${file}`);
}

function update(mac: string, said: string[], ran: string[] = [], pnpm = 0) {
  return updateCommand((line) => said.push(line), async (cmd, args) => (ran.push(`${cmd} ${args.join(' ')}`), cmd === 'pnpm' ? pnpm : 1), { dir: mac });
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('ax-kit update', () => {
  it('fast-forwards a Mac with no edits of its own', async () => {
    const { up, mac } = await repos();
    await upstreamChange(up, 'b.txt', 'b2\n');
    const said: string[] = [];
    const ran: string[] = [];
    expect(await update(mac, said, ran)).toBe(0);
    expect(await readFile(join(mac, 'b.txt'), 'utf8')).toBe('b2\n');
    expect(ran).toContain('pnpm install --frozen-lockfile');
    expect(said.join('\n')).toContain('업데이트 끝');
  });

  it("keeps the Mac's uncommitted and committed edits on top of the new code", async () => {
    const { up, mac } = await repos();
    git(mac, 'commit', '-q', '--allow-empty', '-m', 'self-improvement');
    await writeFile(join(mac, 'a.txt'), 'one\ntwo\nthree (mine)\n');
    await writeFile(join(mac, 'new.txt'), 'added here\n');
    await upstreamChange(up, 'b.txt', 'b2\n');
    const said: string[] = [];
    expect(await update(mac, said)).toBe(0);
    expect(await readFile(join(mac, 'b.txt'), 'utf8')).toBe('b2\n');
    expect(await readFile(join(mac, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree (mine)\n');
    expect(await readFile(join(mac, 'new.txt'), 'utf8')).toBe('added here\n');
    expect(git(mac, 'log', '-1', '--format=%s')).toMatch(/^이 맥에서 고친 내용 \(/);
    expect(git(mac, 'status', '--porcelain')).toBe('');
    expect(said.join('\n')).toContain('다시 얹었어요');
    expect(git(mac, 'rev-parse', '--verify', BEFORE_UPDATE_BRANCH)).not.toBe('');
  });

  it('puts everything back when the edits clash with the new code', async () => {
    const { up, mac } = await repos();
    await writeFile(join(mac, 'a.txt'), 'one\ntwo\nthree (mine)\n');
    await upstreamChange(up, 'a.txt', 'one\ntwo\nthree (theirs)\n');
    const said: string[] = [];
    expect(await update(mac, said)).toBe(1);
    expect(await readFile(join(mac, 'a.txt'), 'utf8')).toBe('one\ntwo\nthree (mine)\n');
    expect(said.join('\n')).toContain('겹치는 파일: a.txt');
    // the next run starts cleanly, not stuck in a half-finished replay
    expect(await update(mac, [])).toBe(1);
  });

  it('goes back when the new code does not start', async () => {
    const { up, mac } = await repos();
    const before = git(mac, 'rev-parse', 'HEAD');
    await upstreamChange(up, 'bin/ax-kit.mjs', 'process.exit(3);\n');
    const said: string[] = [];
    expect(await update(mac, said)).toBe(1);
    expect(git(mac, 'rev-parse', 'HEAD')).toBe(before);
    expect(said.join('\n')).toContain('새 코드가 시작되지 않아서');
  });

  it('goes back when the packages do not install', async () => {
    const { up, mac } = await repos();
    const before = git(mac, 'rev-parse', 'HEAD');
    await upstreamChange(up, 'b.txt', 'b2\n');
    expect(await update(mac, [], [], 1)).toBe(1);
    expect(git(mac, 'rev-parse', 'HEAD')).toBe(before);
  });
});
