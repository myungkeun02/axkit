import { describe, expect, it } from 'vitest';
import { SKIP_DIRS, scanWalk } from '../../../src/connectors/local-files/scan-walk.js';
import type { ScanWalkOptions } from '../../../src/connectors/local-files/scan-walk.js';
import type { FileRules } from '../../../src/core/files/filter.js';
import { DEFAULT_FILE_RULES } from '../../../src/core/files/filter.js';
import { FakeLocalFs, captureLogger } from './helpers.js';

const DOCS = '/home/me/Documents';

function rules(overrides: Partial<FileRules> = {}): FileRules {
  return { ...DEFAULT_FILE_RULES, ...overrides };
}

function walk(fs: FakeLocalFs, overrides: Partial<Omit<ScanWalkOptions, 'fs'>> = {}) {
  return scanWalk({
    fs,
    roots: [{ real: DOCS, display: '~/Documents' }],
    rules: rules(),
    maxEntries: 1_000,
    maxDepth: 5,
    log: captureLogger(),
    ...overrides,
  });
}

describe('scanWalk', () => {
  it('lists files newest first with display paths and readability', async () => {
    const fs = new FakeLocalFs()
      .addFile(`${DOCS}/a.md`, 'a', 1_000)
      .addFile(`${DOCS}/b.txt`, 'b', 2_000)
      .addFile(`${DOCS}/plan.pdf`, 'pdf', 3_000)
      .addFile(`${DOCS}/big.md`, 'x'.repeat(50), 4_000)
      .addFile(`${DOCS}/sub/c.md`, 'c', 5_000);

    const result = await walk(fs, { rules: rules({ maxBytes: 10 }) });

    expect(result.files.map((file) => file.path)).toEqual([
      '~/Documents/sub/c.md',
      '~/Documents/big.md',
      '~/Documents/plan.pdf',
      '~/Documents/b.txt',
      '~/Documents/a.md',
    ]);
    expect(result.files.map((file) => file.readable)).toEqual([true, false, false, true, true]);
    expect(result.files[0]).toMatchObject({
      id: `${DOCS}/sub/c.md`,
      name: 'c.md',
      ext: 'md',
      size: 1,
      modifiedAt: new Date(5_000).toISOString(),
    });
    expect(result.truncated).toBe(false);
  });

  it('skips hidden entries and symlinks', async () => {
    const fs = new FakeLocalFs()
      .addFile(`${DOCS}/safe.md`, 'safe', 1_000)
      .addFile(`${DOCS}/.hidden.md`, 'hidden', 2_000)
      .addSymlink(`${DOCS}/link.md`, `${DOCS}/safe.md`, 3_000)
      .addFile('/home/me/Outside/escape.md', 'outside', 4_000)
      .addSymlink(`${DOCS}/escape`, '/home/me/Outside', 5_000);

    const result = await walk(fs);

    expect(result.files.map((file) => file.path)).toEqual(['~/Documents/safe.md']);
  });

  it('never lists sensitive files or descends into sensitive folders', async () => {
    const fs = new FakeLocalFs()
      .addFile(`${DOCS}/.env`, 'KEY=1', 1_000)
      .addFile(`${DOCS}/여권.pdf`, 'passport', 2_000)
      .addFile(`${DOCS}/.ssh/config`, 'host', 3_000)
      .addFile(`${DOCS}/safe.md`, 'safe', 4_000);

    const result = await walk(fs);

    expect(result.files.map((file) => file.path)).toEqual(['~/Documents/safe.md']);
  });

  it('skips dependency and build folders regardless of case', async () => {
    const fs = new FakeLocalFs()
      .addFile(`${DOCS}/node_modules/pkg/index.js`, 'x', 1_000)
      .addFile(`${DOCS}/Documents/Library/cache.db`, 'x', 2_000)
      .addFile(`${DOCS}/dist/bundle.js`, 'x', 3_000)
      .addFile(`${DOCS}/keep.md`, 'keep', 4_000);

    const result = await walk(fs);

    expect(SKIP_DIRS.has('node_modules')).toBe(true);
    expect(result.files.map((file) => file.path)).toEqual(['~/Documents/keep.md']);
  });

  it('detects repositories with a .git directory or file and hides their files', async () => {
    const app = `${DOCS}/app`;
    const worktree = `${DOCS}/worktree`;
    const fs = new FakeLocalFs()
      .addFile(`${app}/src/main.ts`, 'main', 7_000)
      .addFile(`${app}/readme.md`, 'readme', 6_000)
      .addDir(`${app}/.git/objects`, 1_000)
      .addFile(`${worktree}/.git`, 'gitdir: elsewhere', 1_000)
      .addFile(`${worktree}/index.ts`, 'index', 4_000);

    const result = await walk(fs);

    expect(result.files).toEqual([]);
    expect(result.repos.map((repo) => repo.path)).toEqual(['~/Documents/app', '~/Documents/worktree']);
    expect(result.repos[0]).toMatchObject({
      id: app,
      name: 'app',
      modifiedAt: new Date(7_000).toISOString(),
    });
    expect(result.repos[1]).toMatchObject({
      id: worktree,
      name: 'worktree',
      modifiedAt: new Date(4_000).toISOString(),
    });
  });

  it('dates a repository with nothing but .git by the .git folder, which moves with every commit', async () => {
    const repo = `${DOCS}/bare`;
    const fs = new FakeLocalFs().addDir(`${repo}/.git`, 3_000);
    fs.addDir(repo, 5_000);

    const result = await walk(fs);

    expect(result.repos).toHaveLength(1);
    expect(result.repos[0]?.modifiedAt).toBe(new Date(3_000).toISOString());
  });

  it('truncates at maxEntries', async () => {
    const fs = new FakeLocalFs();
    for (let index = 0; index < 6; index += 1) {
      fs.addFile(`${DOCS}/f${index}.md`, String(index), 1_000 + index);
    }

    const result = await walk(fs, { maxEntries: 3 });

    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(3);
  });

  it('does not enter folders deeper than maxDepth', async () => {
    const fs = new FakeLocalFs()
      .addFile(`${DOCS}/one/two/ok.md`, 'ok', 1_000)
      .addFile(`${DOCS}/one/two/three/deep.md`, 'deep', 2_000);

    const result = await walk(fs, { maxDepth: 2 });

    expect(result.files.map((file) => file.path)).toEqual(['~/Documents/one/two/ok.md']);
  });

  it('throws an AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fs = new FakeLocalFs().addFile(`${DOCS}/a.md`, 'a', 1_000);

    await expect(walk(fs, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});
