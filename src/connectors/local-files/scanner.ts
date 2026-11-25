import { relative } from 'node:path';
import type { FolderScan, FolderScanner, FolderWalk, RepoDetails, RepoRoot, ScannedFile } from '../../core/contracts/scan.js';
import type { FileRules } from '../../core/files/filter.js';
import { fileVerdict } from '../../core/files/filter.js';
import type { Logger } from '../../core/log/types.js';
import type { ProcessRunner } from '../../core/process/types.js';
import type { LocalFs } from './fs.js';
import { readRepo } from './git.js';
import { displayPath, expandFolder } from './paths.js';
import { listRepoDocs, locateRepo } from './repo-locate.js';
import { MAX_DOCUMENT_BYTES, TEXTUTIL_EXTS, textutilText } from './doc-text.js';
import { extensionOf, isSensitivePath } from '../../core/files/filter.js';
import type { ScanRoot } from './scan-walk.js';
import { scanWalk } from './scan-walk.js';
import { isInside } from './walk.js';

/** The first look reads every document in the chosen folders; this only stops a runaway walk. */
const DEFAULT_MAX_ENTRIES = 200_000;
const DEFAULT_MAX_DEPTH = 12;
const REPO_COMMITS = 15;
const README_BYTES = 4_000;

export interface LocalFolderScannerOptions {
  fs: LocalFs;
  run: ProcessRunner;
  rules: FileRules;
  home: string;
  log: Logger;
  maxEntries?: number;
  maxDepth?: number;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function displayOf(root: ScanRoot, real: string): string {
  const rel = relative(root.real, real).split('\\').join('/');
  return rel === '' ? root.display : `${root.display}/${rel}`;
}

/** Opens the owner's chosen folders for a read-only first look. */
export class LocalFolderScanner implements FolderScanner {
  constructor(private readonly options: LocalFolderScannerOptions) {}

  open(folders: readonly string[]): FolderScan {
    let roots: Promise<ScanRoot[]> | undefined;
    const rootList = (): Promise<ScanRoot[]> => (roots ??= this.resolveRoots(folders));
    return {
      walk: async (signal): Promise<FolderWalk> => {
        const resolved = await rootList();
        return scanWalk({
          fs: this.options.fs,
          roots: resolved,
          rules: this.options.rules,
          maxEntries: this.options.maxEntries ?? DEFAULT_MAX_ENTRIES,
          maxDepth: this.options.maxDepth ?? DEFAULT_MAX_DEPTH,
          ...(signal !== undefined ? { signal } : {}),
          log: this.options.log,
        });
      },
      excerpt: (id, maxBytes) => this.excerpt(rootList, id, maxBytes),
      repo: (id) => this.repo(rootList, id),
      repoDocs: (id, max) => this.repoDocs(rootList, id, max),
      documentText: (id, maxChars) => this.documentText(rootList, id, maxChars),
    };
  }

  async locate(path: string): Promise<RepoRoot | undefined> {
    let home = this.options.home;
    try {
      home = await this.options.fs.realpath(home);
    } catch {
      // Keep the configured home.
    }
    return await locateRepo(this.options.fs, home, path);
  }

  private async documentText(rootList: () => Promise<ScanRoot[]>, id: string, maxChars: number): Promise<string | undefined> {
    if (!TEXTUTIL_EXTS.has(extensionOf(id))) return undefined;
    const info = await this.options.fs.lstat(id);
    if (info.isSymbolicLink || !info.isFile || info.size > MAX_DOCUMENT_BYTES) return undefined;
    const resolved = await this.options.fs.realpath(id);
    const root = (await rootList()).find((candidate) => isInside(candidate.real, resolved));
    if (root === undefined) throw new Error('The file is outside the scan folders.');
    if (isSensitivePath(displayOf(root, resolved), this.options.rules.exclude)) throw new Error('The file is not allowed by the current file rules.');
    return await textutilText(this.options.run, resolved, maxChars);
  }

  private async repoDocs(rootList: () => Promise<ScanRoot[]>, id: string, max: number): Promise<ScannedFile[]> {
    const resolved = await this.options.fs.realpath(id);
    const root = (await rootList()).find((candidate) => isInside(candidate.real, resolved));
    if (root === undefined) throw new Error('The repository is outside the scan folders.');
    return await listRepoDocs(
      { fs: this.options.fs, run: this.options.run, rules: this.options.rules, log: this.options.log },
      resolved,
      displayOf(root, resolved),
      max,
    );
  }

  private async resolveRoots(folders: readonly string[]): Promise<ScanRoot[]> {
    const roots: ScanRoot[] = [];
    const seen = new Set<string>();
    // Folders resolve to real paths, so home must too, or a symlinked home would cite absolute paths.
    let realHome = this.options.home;
    try {
      realHome = await this.options.fs.realpath(this.options.home);
    } catch {
      // Keep the configured home.
    }
    for (const folder of folders) {
      const expanded = expandFolder(folder, this.options.home);
      if (expanded === undefined) {
        this.options.log.warn('folder-scan: a folder is not an absolute path');
        continue;
      }
      let real: string;
      try {
        real = await this.options.fs.realpath(expanded);
      } catch (error) {
        this.options.log.warn('folder-scan: a folder could not be opened', { error: errorName(error) });
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      roots.push({ real, display: displayPath(real, realHome) });
    }
    return roots;
  }

  private async excerpt(rootList: () => Promise<ScanRoot[]>, id: string, maxBytes: number): Promise<string> {
    const info = await this.options.fs.lstat(id);
    if (info.isSymbolicLink) throw new Error('Refusing to read a symlink.');
    if (!info.isFile) throw new Error('Not a regular file.');

    const resolved = await this.options.fs.realpath(id);
    const root = (await rootList()).find((candidate) => isInside(candidate.real, resolved));
    if (root === undefined) throw new Error('The file is outside the scan folders.');
    if (fileVerdict(displayOf(root, resolved), info.size, this.options.rules) !== 'ok') {
      throw new Error('The file is not allowed by the current file rules.');
    }

    const cap = Math.min(Math.max(0, maxBytes), this.options.rules.maxBytes);
    if (cap === 0) return '';
    const bytes = await this.options.fs.readFile(resolved);
    return Buffer.from(bytes).subarray(0, cap).toString('utf8');
  }

  private async repo(rootList: () => Promise<ScanRoot[]>, id: string): Promise<RepoDetails> {
    const resolved = await this.options.fs.realpath(id);
    const root = (await rootList()).find((candidate) => isInside(candidate.real, resolved));
    if (root === undefined) throw new Error('The repository is outside the scan folders.');

    const entries = await this.options.fs.readdir(resolved);
    if (!entries.some((entry) => entry.name === '.git')) throw new Error('Not a git repository.');

    return readRepo({ fs: this.options.fs, run: this.options.run, log: this.options.log }, resolved, {
      commits: REPO_COMMITS,
      readmeBytes: README_BYTES,
      rules: this.options.rules,
    });
  }
}
