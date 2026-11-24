import { basename, dirname, join } from 'node:path';
import type { RepoRoot, ScannedFile } from '../../core/contracts/scan.js';
import type { FileRules } from '../../core/files/filter.js';
import { extensionOf, fileVerdict } from '../../core/files/filter.js';
import type { Logger } from '../../core/log/types.js';
import type { ProcessRunner } from '../../core/process/types.js';
import type { LocalFs } from './fs.js';
import { displayPath } from './paths.js';

const MAX_PARENTS = 12;
const MAX_CONFIG_BYTES = 64_000;
const DOC_EXTS = new Set(['md', 'markdown', 'txt', 'rst', 'org', 'adoc']);
const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'core.hooksPath=/dev/null'];

/** "https://user:token@github.com/a/b.git" and "git@github.com:a/b.git" both become "github.com/a/b". */
export function cleanRemote(url: string): string | undefined {
  const trimmed = url.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(trimmed);
  let host: string;
  let path: string;
  if (scp !== null && !trimmed.includes('://')) {
    host = scp[1] ?? '';
    path = scp[2] ?? '';
  } else {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  const clean = path.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  return host === '' || clean === '' ? undefined : `${host}/${clean}`;
}

/** The origin url in a git config file, or the first remote when there is no origin. */
export function remoteFromConfig(text: string): string | undefined {
  let section = '';
  const urls = new Map<string, string>();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const header = /^\[remote\s+"([^"]+)"\]$/.exec(line);
    if (header !== null) {
      section = header[1] ?? '';
      continue;
    }
    if (line.startsWith('[')) {
      section = '';
      continue;
    }
    const url = /^url\s*=\s*(.+)$/.exec(line);
    if (section !== '' && url !== null && !urls.has(section)) urls.set(section, url[1] ?? '');
  }
  const chosen = urls.get('origin') ?? [...urls.values()][0];
  return chosen === undefined ? undefined : cleanRemote(chosen);
}

async function gitDirOf(fs: LocalFs, root: string): Promise<string | undefined> {
  const dotGit = join(root, '.git');
  const info = await fs.lstat(dotGit);
  if (info.isDirectory) return dotGit;
  if (!info.isFile || info.size > MAX_CONFIG_BYTES) return undefined;
  // A worktree or submodule: ".git" is a file pointing at the real git folder.
  const text = Buffer.from(await fs.readFile(dotGit)).toString('utf8');
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (match === null) return undefined;
  const target = (match[1] ?? '').trim();
  return target.startsWith('/') ? target : join(root, target);
}

/** A linked worktree keeps its config in the main repository ("commondir"); undefined for an ordinary one. */
async function commonDirOf(fs: LocalFs, gitDir: string): Promise<string | undefined> {
  try {
    const common = Buffer.from(await fs.readFile(join(gitDir, 'commondir'))).toString('utf8').trim();
    if (common === '') return undefined;
    return common.startsWith('/') ? common : join(gitDir, common);
  } catch {
    return undefined;
  }
}

async function remoteOf(fs: LocalFs, configDir: string): Promise<string | undefined> {
  try {
    const info = await fs.lstat(join(configDir, 'config'));
    if (!info.isFile || info.size > MAX_CONFIG_BYTES) return undefined;
    return remoteFromConfig(Buffer.from(await fs.readFile(join(configDir, 'config'))).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** The nearest working tree holding `path`; reads files only, never runs git. */
export async function locateRepo(fs: LocalFs, home: string, path: string): Promise<RepoRoot | undefined> {
  let current: string;
  try {
    current = await fs.realpath(path);
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < MAX_PARENTS; depth += 1) {
    try {
      const gitDir = await gitDirOf(fs, current);
      if (gitDir !== undefined) {
        const common = await commonDirOf(fs, gitDir);
        const remote = await remoteOf(fs, common ?? gitDir);
        // A worktree (".claude-worktrees/app/x") is the same project as its main checkout.
        let root = current;
        if (common !== undefined && basename(common) === '.git') {
          try {
            root = await fs.realpath(dirname(common));
          } catch {
            root = current;
          }
        }
        return { root, display: displayPath(root, home), name: basename(root), ...(remote !== undefined ? { remote } : {}) };
      }
    } catch {
      // No .git here; look one folder up.
    }
    const parent = dirname(current);
    if (parent === current || current === home) return undefined;
    current = parent;
  }
  return undefined;
}

export interface RepoDocsDeps {
  fs: LocalFs;
  run: ProcessRunner;
  rules: FileRules;
  log: Logger;
}

/** Text documents git tracks in the repository, README and docs first, then by path. */
export async function listRepoDocs(deps: RepoDocsDeps, repo: string, display: string, max: number): Promise<ScannedFile[]> {
  let stdout: string;
  try {
    const result = await deps.run('git', [...SAFE_CONFIG, '-C', repo, 'ls-files', '-z'], {
      timeoutMs: 10_000,
      env: { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.code !== 0 || result.timedOut) return [];
    stdout = result.stdout;
  } catch {
    deps.log.warn('folder-scan: git could not list a repository');
    return [];
  }
  const rank = (rel: string): number => (/^readme/i.test(basename(rel)) ? 0 : /^docs?\//i.test(rel) ? 1 : 2);
  const paths = stdout
    .split('\0')
    .filter((rel) => rel !== '' && DOC_EXTS.has(extensionOf(basename(rel))))
    .sort((left, right) => rank(left) - rank(right) || left.split('/').length - right.split('/').length || left.localeCompare(right));
  const out: ScannedFile[] = [];
  for (const rel of paths) {
    if (out.length >= max) break;
    const shown = `${display}/${rel}`;
    try {
      const info = await deps.fs.lstat(join(repo, rel));
      if (info.isSymbolicLink || !info.isFile) continue;
      if (fileVerdict(shown, info.size, deps.rules) !== 'ok') continue;
      out.push({
        id: join(repo, rel),
        path: shown,
        name: basename(rel),
        ext: extensionOf(basename(rel)),
        size: info.size,
        modifiedAt: new Date(info.mtimeMs).toISOString(),
        readable: true,
      });
    } catch {
      continue;
    }
  }
  return out;
}
