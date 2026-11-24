import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProcessRunner } from '../../core/process/types.js';

const ROOTS = ['Documents', 'dev', 'Projects', 'projects', 'code', 'src', 'workspace', 'Developer', 'repos', 'github', 'GitHub'];
const SKIP = new Set(['node_modules', 'Library', '.Trash', 'vendor', 'dist', 'build', '.next', 'target', '.git', 'Pods']);
const MAX_DEPTH = 6;
const MAX_FOUND = 40;

export interface LocalProject {
  name: string;
  path: string;
  /** False for a folder that was `git init`-ed but never committed: there is nothing to branch from yet. */
  hasCommits: boolean;
  remote?: string;
}

/** Git projects in the usual folders of this Mac (read-only: lists folders and asks git two questions). */
export async function findLocalProjects(run: ProcessRunner, home = homedir()): Promise<LocalProject[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (found.length >= MAX_FOUND || depth > MAX_DEPTH) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    if (entries.some((entry) => entry.name === '.git')) found.push(dir);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  };
  for (const root of ROOTS) {
    const dir = join(home, root);
    if ((await stat(dir).catch(() => undefined))?.isDirectory() === true) await walk(dir, 1);
  }
  const git = async (dir: string, args: string[]) => await run('git', ['-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { timeoutMs: 10_000 }).catch(() => undefined);
  return await Promise.all(
    found.map(async (path) => {
      const head = await git(path, ['rev-parse', '--verify', '--quiet', 'HEAD']);
      const remote = await git(path, ['remote', 'get-url', 'origin']);
      return { name: path.split('/').at(-1) ?? path, path: path.replace(home, '~'), hasCommits: head?.code === 0, ...(remote?.code === 0 && remote.stdout.trim() !== '' ? { remote: remote.stdout.trim().replace(/\/\/[^@/]+@/, '//') } : {}) };
    }),
  );
}
