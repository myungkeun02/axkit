import { basename, isAbsolute } from 'node:path';
import type { FolderScan, FolderWalk, RepoDetails, RepoRoot, ScannedFile } from '../../core/contracts/scan.js';
import type { AgentSession, AgentSessionReader } from '../../core/contracts/sessions.js';
import type { FileRules } from '../../core/files/filter.js';
import { isSensitivePath } from '../../core/files/filter.js';
import { isExcludedHomePath, relativeToHome } from '../../core/files/home.js';
import type { Logger } from '../../core/log/types.js';
import type { ProcessRunner } from '../../core/process/types.js';
import { SOURCE_LIMITS } from '../../core/remote/protocol.js';
import type { LocalFs } from '../../connectors/local-files/fs.js';
import { displayPath, expandFolder } from '../../connectors/local-files/paths.js';
import { LocalFolderScanner } from '../../connectors/local-files/scanner.js';
import { isInside } from '../../connectors/local-files/walk.js';

/** A request the work Mac will not answer: outside the shared folders, a sensitive name, or not there. */
export class SourceRefusal extends Error {
  override readonly name = 'SourceRefusal';
}

export interface SourceOpsOptions {
  fs: LocalFs;
  run: ProcessRunner;
  rules: FileRules;
  home: string;
  folders: readonly string[];
  /** Undefined when the owner chose not to share sessions. */
  sessions?: AgentSessionReader;
  log: Logger;
}

const FIND_TIMEOUT_MS = 15_000;
const FIND_LINES = 2_000;

/**
 * What `ax-kit source serve` does for each request, over the folders this Mac's owner shared. Paths go out as "~/x"
 * below home (absolute otherwise) and come back the same way. Read-only: nothing here writes or runs a write.
 */
export class SourceOps {
  private home?: string;
  private rootList?: Promise<string[]>;
  private scanner?: LocalFolderScanner;
  private allScan?: FolderScan;

  constructor(private readonly options: SourceOpsOptions) {}

  private async realHome(): Promise<string> {
    if (this.home !== undefined) return this.home;
    try {
      this.home = await this.options.fs.realpath(this.options.home);
    } catch {
      this.home = this.options.home;
    }
    return this.home;
  }

  private async scan(): Promise<{ scanner: LocalFolderScanner; all: FolderScan; roots: string[] }> {
    const home = await this.realHome();
    this.scanner ??= new LocalFolderScanner({ fs: this.options.fs, run: this.options.run, rules: this.options.rules, home, log: this.options.log, maxEntries: SOURCE_LIMITS.walkEntries });
    const roots = await (this.rootList ??= this.resolveRoots(home));
    this.allScan ??= this.scanner.open(roots);
    return { scanner: this.scanner, all: this.allScan, roots };
  }

  private async resolveRoots(home: string): Promise<string[]> {
    const roots: string[] = [];
    for (const folder of this.options.folders) {
      const expanded = expandFolder(folder, home);
      if (expanded === undefined) continue;
      try {
        const real = await this.options.fs.realpath(expanded);
        if (!roots.includes(real)) roots.push(real);
      } catch {
        this.options.log.warn('source: a shared folder could not be opened');
      }
    }
    return roots;
  }

  private async wire(path: string): Promise<string> {
    return displayPath(path, await this.realHome());
  }

  /** A wire path → a real path inside a shared folder, or a refusal. Sensitive names are refused before any read. */
  private async inside(path: string): Promise<string> {
    if (path.includes('\0')) throw new SourceRefusal('bad path');
    const home = await this.realHome();
    const expanded = expandFolder(path, home);
    if (expanded === undefined || !isAbsolute(expanded)) throw new SourceRefusal('bad path');
    if (isSensitivePath(displayPath(expanded, home), this.options.rules.exclude)) throw new SourceRefusal('sensitive');
    let real: string;
    try {
      real = await this.options.fs.realpath(expanded);
    } catch {
      throw new SourceRefusal('not found');
    }
    const { roots } = await this.scan();
    if (!roots.some((root) => isInside(root, real))) throw new SourceRefusal('outside');
    if (isSensitivePath(displayPath(real, home), this.options.rules.exclude)) throw new SourceRefusal('sensitive');
    return real;
  }

  private async file(file: ScannedFile): Promise<ScannedFile> {
    return { ...file, id: await this.wire(file.id) };
  }

  async info(host: string): Promise<{ host: string; folders: string[]; sessions: boolean }> {
    const home = await this.realHome();
    const { roots } = await this.scan();
    return { host, folders: roots.map((root) => displayPath(root, home)), sessions: this.options.sessions !== undefined };
  }

  /** Every shared folder, or the requested ones that are inside them (others are left out, not an error). */
  async walk(all: boolean, folders: readonly string[], signal?: AbortSignal): Promise<FolderWalk> {
    const { scanner, roots } = await this.scan();
    let chosen = roots;
    if (!all) {
      chosen = [];
      for (const folder of folders) {
        const real = await this.inside(folder).catch(() => undefined);
        if (real !== undefined && !chosen.includes(real)) chosen.push(real);
      }
    }
    if (chosen.length === 0) return { files: [], repos: [], truncated: false };
    const walk = await scanner.open(chosen).walk(signal);
    return {
      files: await Promise.all(walk.files.map((file) => this.file(file))),
      repos: await Promise.all(walk.repos.map(async (repo) => ({ ...repo, id: await this.wire(repo.id) }))),
      truncated: walk.truncated,
    };
  }

  async excerpt(id: string, maxBytes: number): Promise<string> {
    const real = await this.inside(id);
    return await (await this.scan()).all.excerpt(real, Math.min(maxBytes, SOURCE_LIMITS.excerptBytes));
  }

  async repo(id: string): Promise<RepoDetails> {
    return await (await this.scan()).all.repo(await this.inside(id));
  }

  async repoDocs(id: string, max: number): Promise<ScannedFile[]> {
    const real = await this.inside(id);
    const docs = (await (await this.scan()).all.repoDocs?.(real, Math.min(max, SOURCE_LIMITS.repoDocs))) ?? [];
    return await Promise.all(docs.map((doc) => this.file(doc)));
  }

  async documentText(id: string, maxChars: number): Promise<string | undefined> {
    const real = await this.inside(id);
    return await (await this.scan()).all.documentText?.(real, Math.min(maxChars, SOURCE_LIMITS.documentChars));
  }

  /** Only folders inside the shared ones are looked up; anything else is simply "no repository". */
  async locate(path: string): Promise<RepoRoot | undefined> {
    const real = await this.inside(path).catch(() => undefined);
    if (real === undefined) return undefined;
    const root = await (await this.scan()).scanner.locate(real);
    return root === undefined ? undefined : { ...root, root: await this.wire(root.root) };
  }

  async sessionList(signal?: AbortSignal): Promise<AgentSession[]> {
    if (this.options.sessions === undefined) return [];
    const list = await this.options.sessions.list(signal);
    return await Promise.all(list.map(async (session) => ({ ...session, cwd: await this.wire(session.cwd) })));
  }

  async transcript(tool: AgentSession['tool'], id: string, maxChars: number): Promise<string | undefined> {
    if (this.options.sessions === undefined) return undefined;
    return await this.options.sessions.transcript({ tool, id }, Math.min(maxChars, SOURCE_LIMITS.transcriptChars));
  }

  /** Spotlight by name, only inside the shared folders; hidden, app-data and sensitive names never come back. */
  async find(query: string, limit: number): Promise<{ name: string; path: string; size: number; modifiedAt: string }[]> {
    const cleaned = query.replace(/^-+/, '').trim();
    if (cleaned === '') return [];
    const home = await this.realHome();
    const { roots } = await this.scan();
    const found: { name: string; path: string; size: number; modifiedAt: string }[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      if (found.length >= limit) break;
      let result;
      try {
        result = await this.options.run('mdfind', ['-onlyin', root, '-name', cleaned], { timeoutMs: FIND_TIMEOUT_MS });
      } catch {
        continue;
      }
      if (result.code !== 0 || result.timedOut) continue;
      for (const line of result.stdout.split('\n').slice(0, FIND_LINES)) {
        if (found.length >= limit) break;
        const path = line.trim();
        if (path === '' || !isAbsolute(path) || seen.has(path) || !isInside(root, path)) continue;
        seen.add(path);
        const rel = relativeToHome(path, home);
        if ((rel !== undefined && isExcludedHomePath(rel, this.options.rules.exclude)) || isSensitivePath(path, this.options.rules.exclude)) continue;
        const info = await this.options.fs.lstat(path).catch(() => undefined);
        if (info === undefined || !info.isFile) continue;
        found.push({ name: basename(path), path: displayPath(path, home), size: info.size, modifiedAt: new Date(info.mtimeMs).toISOString() });
      }
    }
    return found;
  }
}
