import type { RepoRoot, ScannedFile, ScannedRepo } from '../../core/contracts/scan.js';
import type { AgentSession } from '../../core/contracts/sessions.js';
import { parseRemote, remoteDisplay, remoteHomeOf } from '../../core/remote/ids.js';

/** A project the owner could import, merged from folders and Claude Code / Codex sessions. */
export interface ProjectCandidate {
  /** Real absolute path; the key the owner's choice is stored under. */
  path: string;
  /** "~/dev/app" style. */
  display: string;
  name: string;
  /** Best guess; the owner can rename or move it. */
  company: string;
  remote?: string;
  /** ISO 8601 of the newest file, commit or session. */
  lastActive: string;
  claude: number;
  codex: number;
  /** Found as a git repository in the chosen folders. */
  inFolders: boolean;
  /** A folder of documents (not code): how many it holds. */
  docs?: number;
}

/** What the owner picked, stored in the onboarding config. */
export interface PickedProject {
  path: string;
  name: string;
  company: string;
  /** "github.com/owner/repo": lets the server set the repository up for development on its own. */
  remote?: string | undefined;
}

export interface DiscoverDeps {
  repos: readonly ScannedRepo[];
  /** Files from the folder walk: folders full of documents are work too (a brand redesign, a production plan). */
  files?: readonly ScannedFile[];
  sessions: readonly AgentSession[];
  locate: (path: string) => Promise<RepoRoot | undefined>;
  home: string;
  /** Used when nothing names a company. */
  personal: string;
}

const MAX_CANDIDATES = 200;
/** A folder that is not a repository still counts after this many owner turns. */
const MIN_LOOSE_TURNS = 3;
/** Folder names that say nothing about whose work it is. */
const GENERIC = new Set([
  'dev',
  'developer',
  'projects',
  'project',
  'code',
  'src',
  'repos',
  'repo',
  'git',
  'github',
  'gitlab',
  'work',
  'workspace',
  'workspaces',
  'documents',
  'desktop',
  'downloads',
  'sites',
  'apps',
  'tmp',
  'temp',
  // folders AI tools and apps make for their own files; never a company
  'chatgpt',
  'codex',
  'claude',
  'cursor',
  'notion',
  'obsidian',
  'dropbox',
  'google drive',
  'icloud drive',
  'onedrive',
]);
/** Places coding tools make on their own; never a project. */
const SCRATCH = [/\/Library\//, /^\/private\//, /^\/tmp\//, /^\/var\//, /\/\.claude-worktrees\//, /\/\.codex\//, /\/\.claude\//, /\/node_modules\//];

function isScratch(path: string): boolean {
  // A path on a paired Mac ("remote:MacBook:/private/…") is judged by its own part.
  const own = parseRemote(path)?.path ?? path;
  return SCRATCH.some((pattern) => pattern.test(`${own}/`));
}

/** This Mac's home, or "remote:MacBook:~" for a path on a paired Mac. */
function homeFor(path: string, home: string): string {
  return remoteHomeOf(path) ?? home;
}

function displayOf(path: string, home: string): string {
  const remote = remoteDisplay(path);
  if (remote !== undefined) return remote;
  if (path === home) return '~';
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function baseName(path: string): string {
  return path.split('/').filter((part) => part !== '').at(-1) ?? path;
}

/** The organisation in "github.com/acme/app", else the folder above the project unless it is a generic one. */
export function guessCompany(path: string, remote: string | undefined, home: string, personal: string): string {
  const owner = remote?.split('/')[1];
  if (owner !== undefined && owner !== '') return owner;
  const parts = path.split('/').filter((part) => part !== '');
  const homeDepth = home.split('/').filter((part) => part !== '').length;
  for (let index = parts.length - 2; index >= homeDepth; index -= 1) {
    const part = parts[index] ?? '';
    if (!GENERIC.has(part.toLowerCase()) && !part.startsWith('.')) return part;
  }
  return personal;
}

function newer(left: string, right: string): string {
  return left.localeCompare(right) >= 0 ? left : right;
}

/** Every project the owner has worked on, newest first. A folder's sessions are tied to its git working tree. */
export async function discoverProjects(deps: DiscoverDeps): Promise<ProjectCandidate[]> {
  const byPath = new Map<string, ProjectCandidate & { remoteKnown: boolean }>();
  const add = (root: RepoRoot | { root: string; name: string; remote?: string }, at: string, from: 'folder' | AgentSession['tool']): void => {
    if (isScratch(root.root) || root.root === homeFor(root.root, deps.home)) return;
    const existing = byPath.get(root.root);
    if (existing !== undefined) {
      existing.lastActive = newer(existing.lastActive, at);
      if (from === 'folder') existing.inFolders = true;
      else existing[from] += 1;
      if (!existing.remoteKnown && root.remote !== undefined) {
        existing.remote = root.remote;
        existing.remoteKnown = true;
        existing.company = guessCompany(root.root, root.remote, homeFor(root.root, deps.home), deps.personal);
      }
      return;
    }
    byPath.set(root.root, {
      path: root.root,
      display: displayOf(root.root, deps.home),
      // "huyeor-v2" from the remote says more than the folder name "v2".
      name: root.remote?.split('/').at(-1) ?? root.name,
      company: guessCompany(root.root, root.remote, homeFor(root.root, deps.home), deps.personal),
      ...(root.remote !== undefined ? { remote: root.remote } : {}),
      remoteKnown: root.remote !== undefined,
      lastActive: at,
      claude: from === 'claude' ? 1 : 0,
      codex: from === 'codex' ? 1 : 0,
      inFolders: from === 'folder',
    });
  };

  for (const repo of deps.repos) {
    const located = await deps.locate(repo.id);
    add(located ?? { root: repo.id, name: repo.name }, repo.modifiedAt, 'folder');
  }

  const roots = new Map<string, RepoRoot | null>();
  const loose = new Map<string, { turns: number; at: string; sessions: AgentSession[] }>();
  for (const session of deps.sessions) {
    let root = roots.get(session.cwd);
    if (root === undefined) {
      root = (await deps.locate(session.cwd)) ?? null;
      roots.set(session.cwd, root);
    }
    if (root !== null) {
      add(root, session.updatedAt, session.tool);
      continue;
    }
    if (isScratch(session.cwd)) continue;
    const entry = loose.get(session.cwd) ?? { turns: 0, at: session.updatedAt, sessions: [] };
    entry.turns += session.turns;
    entry.at = newer(entry.at, session.updatedAt);
    entry.sessions.push(session);
    loose.set(session.cwd, entry);
  }
  const known = [...byPath.keys()];
  for (const [cwd, entry] of loose) {
    if (entry.turns < MIN_LOOSE_TURNS) continue;
    // "~/dev" or a folder holding several repositories is a place, not a project.
    if (GENERIC.has(baseName(cwd).toLowerCase()) || known.some((path) => path.startsWith(`${cwd}/`))) continue;
    const remote = entry.sessions.find((session) => session.gitRemote !== undefined)?.gitRemote;
    for (const session of entry.sessions) add({ root: cwd, name: baseName(cwd), ...(remote !== undefined ? { remote } : {}) }, session.updatedAt, session.tool);
  }

  const files = deps.files ?? [];
  const homes = [deps.home, ...new Set(files.map((file) => remoteHomeOf(file.id)).filter((home): home is string => home !== undefined))];
  for (const folder of homes.flatMap((home) => documentFolders(files, home))) {
    if (byPath.has(folder.path) || [...byPath.keys()].some((path) => folder.path.startsWith(`${path}/`) || path.startsWith(`${folder.path}/`))) continue;
    byPath.set(folder.path, {
      path: folder.path,
      display: displayOf(folder.path, deps.home),
      name: baseName(folder.path),
      company: guessCompany(folder.path, undefined, homeFor(folder.path, deps.home), deps.personal),
      remoteKnown: false,
      lastActive: folder.newest,
      claude: 0,
      codex: 0,
      inFolders: true,
      docs: folder.count,
    });
  }

  return dedupeByRemote([...byPath.values()])
    .map((entry): ProjectCandidate => {
      const { remoteKnown, ...candidate } = entry;
      void remoteKnown;
      return candidate;
    })
    .sort((left, right) => right.lastActive.localeCompare(left.lastActive) || left.path.localeCompare(right.path))
    .slice(0, MAX_CANDIDATES);
}

const DOC_EXTS = new Set(['pdf', 'doc', 'docx', 'hwp', 'hwpx', 'pages', 'key', 'ppt', 'pptx', 'xls', 'xlsx', 'numbers', 'csv', 'md', 'txt', 'rtf', 'odt', 'ai', 'psd', 'fig', 'sketch', 'indd']);
const MIN_DOCS = 5;
const DOC_YEARS = 2;

/**
 * Folders two levels under home ("~/Documents/브랜드A") that hold at least five documents changed in the last two
 * years. Generic folder names and app folders are left out.
 */
export function documentFolders(files: readonly ScannedFile[], home: string): { path: string; count: number; newest: string }[] {
  const cutoff = Date.now() - DOC_YEARS * 365 * 24 * 60 * 60 * 1000;
  const byFolder = new Map<string, { count: number; newest: string }>();
  for (const file of files) {
    if (!DOC_EXTS.has(file.ext) || Date.parse(file.modifiedAt) < cutoff || !file.id.startsWith(`${home}/`)) continue;
    const parts = file.id.slice(home.length + 1).split('/');
    if (parts.length < 3) continue;
    const top = parts[0] ?? '';
    const second = parts[1] ?? '';
    // "~/Documents/브랜드A/…" → ~/Documents/브랜드A; "~/브랜드A/x/…" (own top folder) → ~/브랜드A
    const path = GENERIC.has(top.toLowerCase()) ? `${home}/${top}/${second}` : `${home}/${top}`;
    if (GENERIC.has(baseName(path).toLowerCase()) || baseName(path).startsWith('.') || isScratch(path)) continue;
    const entry = byFolder.get(path) ?? { count: 0, newest: '' };
    entry.count += 1;
    if (file.modifiedAt > entry.newest) entry.newest = file.modifiedAt;
    byFolder.set(path, entry);
  }
  return [...byFolder.entries()].filter(([, entry]) => entry.count >= MIN_DOCS).map(([path, entry]) => ({ path, ...entry }));
}

/** Two checkouts of one repository are one project: the one worked in last stays, with both sessions counted. */
function dedupeByRemote<T extends ProjectCandidate>(candidates: T[]): T[] {
  const byRemote = new Map<string, T>();
  const out: T[] = [];
  for (const candidate of [...candidates].sort((left, right) => right.lastActive.localeCompare(left.lastActive))) {
    const kept = candidate.remote === undefined ? undefined : byRemote.get(candidate.remote);
    if (kept === undefined) {
      if (candidate.remote !== undefined) byRemote.set(candidate.remote, candidate);
      out.push(candidate);
      continue;
    }
    kept.claude += candidate.claude;
    kept.codex += candidate.codex;
    kept.inFolders ||= candidate.inFolders;
  }
  return out;
}

/** Candidates grouped by company, the company with the newest work first. */
export function byCompany(candidates: readonly { company: string; lastActive: string }[]): string[] {
  const newest = new Map<string, string>();
  for (const candidate of candidates) newest.set(candidate.company, newer(newest.get(candidate.company) ?? '', candidate.lastActive));
  return [...newest.entries()].sort((left, right) => right[1].localeCompare(left[1]) || left[0].localeCompare(right[0])).map(([company]) => company);
}

/** Sessions that belong to a picked project (its folder or anything inside it). */
export function sessionsOf(project: { path: string }, sessions: readonly AgentSession[]): AgentSession[] {
  return sessions.filter((session) => session.cwd === project.path || session.cwd.startsWith(`${project.path}/`));
}
