import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ProcessRunner } from '../../core/process/types.js';
import type { Tool } from '../../core/tools/types.js';
import { detectTest, slugOf } from './adopt.js';
import type { DevConfig, RepoConfig } from './config.js';

const ADOPTED_KEY = 'adopted';
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];

const input = z.object({
  path: z.string().min(2).max(400).describe('The project folder on this Mac, e.g. "~/Documents/my-app".'),
  project: z.string().max(80).optional().describe('The project or team it belongs to, for the owner.'),
});

export interface AddRepoOutput {
  slug: string;
  path: string;
  base: string;
  test?: string[];
  message: string;
}

/** "github.com/o/n" from an origin URL (https or ssh). */
export function remoteOf(url: string): string {
  return url.trim().replace(/^git@github\.com:/, 'github.com/').replace(/^https?:\/\//, '').replace(/^[^@/]+@/, '').replace(/\.git$/, '');
}

/** A project that lives only on this Mac gets "local/<folder>" (it never gets a PR, only branches here). */
export function localSlug(path: string): string {
  const name = basename(path).replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[-.]+/, '') || 'project';
  return `local/${name}`;
}

/**
 * Tool "dev.add_repo": registers a project folder that is already on this Mac, in place, so the dev teams can work on
 * it (in their own worktrees and branches; the folder itself and its checked-out branch are never touched).
 */
export function addRepoTool(ctx: PluginContext, config: DevConfig, run: ProcessRunner): Tool<z.infer<typeof input>, AddRepoOutput> {
  const git = async (dir: string, args: string[]) => await run('git', [...SAFE, '-C', dir, ...args], { timeoutMs: 15_000 }).catch(() => ({ code: 1, stdout: '', stderr: '', timedOut: false }));
  return {
    name: 'dev.add_repo',
    description:
      'Register a project folder already on this Mac so the dev teams can work on it (branches in their own worktrees; ' +
      'they never touch the folder or merge). Use it when a dev bot has no repository for its project.',
    input,
    effects: ['write'],
    async run(value) {
      const home = homedir();
      const raw = value.path.trim().replace(/^~(?=\/|$)/, home);
      const path = resolve(isAbsolute(raw) ? raw : join(home, raw));
      if (!path.startsWith(`${home}/`)) throw new Error('Only folders inside your home folder.');
      const top = await git(path, ['rev-parse', '--show-toplevel']);
      if (top.code !== 0) throw new Error(`${value.path} is not a git project.`);
      const root = top.stdout.trim();
      if ((await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0) {
        throw new Error('This project has no commits yet, so there is nothing to branch from. Make a first commit there, then register it.');
      }
      const origin = await git(root, ['remote', 'get-url', 'origin']);
      let slug = (origin.code === 0 ? slugOf(remoteOf(origin.stdout)) : undefined) ?? localSlug(root);
      // two folders of the same name elsewhere ("~/a/app", "~/b/app") are two projects, not one overwriting the other
      const clash = config.repos.find((repo) => repo.slug === slug && repo.path !== root);
      if (clash !== undefined) slug = `${slug}-${createHash('sha1').update(root).digest('hex').slice(0, 6)}`;
      const originHead = origin.code === 0 ? await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']) : undefined;
      const hasMain = async (name: string) => (await git(root, ['rev-parse', '--verify', '--quiet', origin.code === 0 ? `refs/remotes/origin/${name}` : `refs/heads/${name}`])).code === 0;
      const base = originHead?.code === 0 ? originHead.stdout.trim().replace(/^origin\//, '') : (await hasMain('main')) ? 'main' : (await hasMain('master')) ? 'master' : (await git(root, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim() || 'main';
      const test = await detectTest(root);
      const entry = { slug, path: root, base, ...(test !== undefined ? { test } : {}), ...(value.project !== undefined ? { project: value.project } : {}) };
      const stored = await ctx.kv.get<unknown[]>(ADOPTED_KEY);
      const others = (Array.isArray(stored) ? stored : []).filter((item) => (item as { slug?: unknown }).slug !== slug);
      await ctx.kv.set(ADOPTED_KEY, [...others, entry]);
      const index = config.repos.findIndex((repo) => repo.slug === slug);
      const repo = { slug, path: root, base, ...(test !== undefined ? { test } : {}), testTimeoutSeconds: 900 } as RepoConfig;
      if (index >= 0) config.repos[index] = repo;
      else config.repos.push(repo);
      return { slug, path: root, base, ...(test !== undefined ? { test } : {}), message: `${slug} registered (base ${base}${test !== undefined ? `, tests: ${test.join(' ')}` : ', no test command found'}).` };
    },
  };
}
