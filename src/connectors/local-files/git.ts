import { basename, join } from 'node:path';
import type { RepoCommit, RepoDetails } from '../../core/contracts/scan.js';
import type { FileRules } from '../../core/files/filter.js';
import { extensionOf, isSensitivePath } from '../../core/files/filter.js';
import type { Logger } from '../../core/log/types.js';
import type { ProcessRunner, RunOptions, RunResult } from '../../core/process/types.js';
import { maskSecrets } from '../../core/text/mask.js';
import type { LocalFs } from './fs.js';

const README_PATTERN = /^readme(\.(md|markdown|txt|rst))?$/i;
const COMMIT_SEPARATOR = '\x1f';
const MAX_SUBJECT = 200;
const MAX_LANGUAGES = 8;

const MAX_README_FILE = 1_000_000;
/**
 * Repositories under Downloads can come from anyone: repo config must not get to start programs. `log` and `ls-files`
 * never run hooks, and these switch off the config keys that could still run one (fsmonitor) or wait for input.
 */
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null'];

const GIT_OPTIONS: RunOptions = {
  timeoutMs: 10_000,
  env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
};

export interface RepoReadDeps {
  fs: LocalFs;
  run: ProcessRunner;
  log: Logger;
}

export interface RepoReadOptions {
  commits: number;
  readmeBytes: number;
  rules: FileRules;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

async function runGit(deps: RepoReadDeps, args: readonly string[]): Promise<RunResult | undefined> {
  try {
    return await deps.run('git', [...SAFE_CONFIG, ...args], GIT_OPTIONS);
  } catch (error) {
    deps.log.warn('folder-scan: git could not be run', { error: errorName(error) });
    return undefined;
  }
}

async function readReadme(deps: RepoReadDeps, repo: string, maxBytes: number): Promise<string | undefined> {
  let entries;
  try {
    entries = await deps.fs.readdir(repo);
  } catch (error) {
    deps.log.warn('folder-scan: a repository could not be read', { error: errorName(error) });
    return undefined;
  }

  for (const entry of entries) {
    if (!README_PATTERN.test(entry.name)) continue;
    const path = join(repo, entry.name);
    try {
      const info = await deps.fs.lstat(path);
      if (info.isSymbolicLink || !info.isFile || info.size > MAX_README_FILE) continue;
      const bytes = await deps.fs.readFile(path);
      return maskSecrets(Buffer.from(bytes).subarray(0, Math.max(0, maxBytes)).toString('utf8'));
    } catch (error) {
      deps.log.warn('folder-scan: a readme could not be read', { error: errorName(error) });
      continue;
    }
  }
  return undefined;
}

function parseCommits(stdout: string): RepoCommit[] {
  const commits: RepoCommit[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const [at = '', subject = ''] = line.split(COMMIT_SEPARATOR);
    commits.push({ at, subject: maskSecrets(subject).slice(0, MAX_SUBJECT) });
  }
  return commits;
}

async function readCommits(deps: RepoReadDeps, repo: string, count: number): Promise<RepoCommit[]> {
  const result = await runGit(deps, [
    '-C',
    repo,
    'log',
    `-n${count}`,
    '--no-merges',
    '--format=%cI%x1f%s',
  ]);
  if (result === undefined || result.code !== 0 || result.timedOut) return [];
  return parseCommits(result.stdout);
}

async function readLanguages(deps: RepoReadDeps, repo: string, rules: FileRules): Promise<{ ext: string; files: number }[]> {
  const result = await runGit(deps, ['-C', repo, 'ls-files', '-z']);
  if (result === undefined || result.code !== 0 || result.timedOut) return [];

  const counts = new Map<string, number>();
  for (const path of result.stdout.split('\0')) {
    if (path === '' || isSensitivePath(path, rules.exclude)) continue;
    const ext = extensionOf(basename(path));
    if (ext === '') continue;
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }

  return [...counts.entries()]
    .map(([ext, files]) => ({ ext, files }))
    .sort((left, right) => right.files - left.files || left.ext.localeCompare(right.ext))
    .slice(0, MAX_LANGUAGES);
}

/** Reads a repository's readme, recent commits and language mix without changing it. */
export async function readRepo(deps: RepoReadDeps, repo: string, opts: RepoReadOptions): Promise<RepoDetails> {
  const readme = await readReadme(deps, repo, opts.readmeBytes);
  const commits = await readCommits(deps, repo, opts.commits);
  const languages = await readLanguages(deps, repo, opts.rules);
  return { ...(readme !== undefined ? { readme } : {}), commits, languages };
}
