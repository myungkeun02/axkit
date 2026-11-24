import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeLocalFs } from '../../../src/connectors/local-files/fs.js';
import { cleanRemote, locateRepo, remoteFromConfig } from '../../../src/connectors/local-files/repo-locate.js';

describe('repo locate', () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'ax-locate-')));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('cleans remotes of credentials, ports and .git', () => {
    expect(cleanRemote('https://me:secret@github.com/acme/web.git')).toBe('github.com/acme/web');
    expect(cleanRemote('git@github.com:acme/web.git')).toBe('github.com/acme/web');
    expect(cleanRemote('ssh://git@gitlab.example.com:2222/team/app')).toBe('gitlab.example.com/team/app');
    expect(cleanRemote('not a url')).toBeUndefined();
    expect(remoteFromConfig('[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:a/b.git\n[remote "origin"]\n\turl = https://github.com/c/d\n')).toBe('github.com/c/d');
  });

  it('finds the working tree above a folder and maps a worktree to its main checkout', async () => {
    const main = join(home, 'dev', 'acme', 'web');
    await mkdir(join(main, '.git', 'worktrees', 'fix'), { recursive: true });
    await mkdir(join(main, 'src', 'deep'), { recursive: true });
    await writeFile(join(main, '.git', 'config'), '[remote "origin"]\n\turl = https://tok@github.com/acme/acme-web.git\n');
    const tree = join(home, '.claude-worktrees', 'web', 'fix');
    await mkdir(tree, { recursive: true });
    await writeFile(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'fix')}\n`);
    await writeFile(join(main, '.git', 'worktrees', 'fix', 'commondir'), '../..\n');

    expect(await locateRepo(nodeLocalFs, home, join(main, 'src', 'deep'))).toEqual({ root: main, display: '~/dev/acme/web', name: 'web', remote: 'github.com/acme/acme-web' });
    expect(await locateRepo(nodeLocalFs, home, tree)).toEqual({ root: main, display: '~/dev/acme/web', name: 'web', remote: 'github.com/acme/acme-web' });
    expect(await locateRepo(nodeLocalFs, home, join(home, 'dev'))).toBeUndefined();
    expect(await locateRepo(nodeLocalFs, home, join(home, 'gone'))).toBeUndefined();
  });
});
