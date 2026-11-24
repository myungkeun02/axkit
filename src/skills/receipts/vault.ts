import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DocKind } from './types.js';

/** The small slice of node:fs/promises the vault needs; tests record modes through it. */
export interface VaultFs {
  mkdir(path: string, mode: number): Promise<void>;
  writeFile(path: string, data: string | Uint8Array, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  /** Resolves symlinks so a path can be checked against the real vault root. */
  realpath(path: string): Promise<string>;
}

export const NODE_VAULT_FS: VaultFs = {
  async mkdir(target, mode) {
    await mkdir(target, { recursive: true, mode });
  },
  async writeFile(target, data, mode) {
    await writeFile(target, data, { mode });
  },
  async chmod(target, mode) {
    await chmod(target, mode);
  },
  realpath: (target) => realpath(target),
};

export interface VaultFile {
  name: string;
  data: string | Uint8Array;
}

export interface VaultOptions {
  vaultDir?: string;
  fs?: VaultFs;
}

const MAX_NAME = 60;
const FORBIDDEN = /[/\\:\p{Cc}]/gu;

/** File and folder name that cannot escape the vault: no separators, colons, control characters or leading dots. */
export function safeName(value: string): string {
  return value
    .normalize('NFC')
    .replace(FORBIDDEN, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+/, '')
    .slice(0, MAX_NAME)
    .trim();
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

/** A private local folder: dirs 0700, files 0600, every path checked against the root. */
export class Vault {
  readonly root: string | undefined;
  private readonly fs: VaultFs;

  constructor(options: VaultOptions = {}) {
    this.root = options.vaultDir === undefined ? undefined : path.resolve(options.vaultDir);
    this.fs = options.fs ?? NODE_VAULT_FS;
  }

  get enabled(): boolean {
    return this.root !== undefined;
  }

  private resolve(relative: string): string {
    const root = this.root;
    if (root === undefined) throw new Error('vault root is not configured');
    const target = path.resolve(root, relative);
    if (!isInside(root, target)) throw new Error('vault path escapes the root');
    return target;
  }

  /** Absolute path of a vault-relative file, checked to stay inside the root. */
  absoluteOf(relative: string): string {
    return this.resolve(relative);
  }

  /**
   * Real path of an existing vault file. Both the literal and the symlink-resolved path must stay under the root,
   * so a link inside the vault cannot point the reader at other files on disk.
   */
  async realFileOf(target: string): Promise<string> {
    const root = this.root;
    if (root === undefined) throw new Error('vault root is not configured');
    const candidate = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
    if (!isInside(root, candidate)) throw new Error('the path is outside the vault');
    const realRoot = await this.fs.realpath(root);
    const real = await this.fs.realpath(candidate);
    if (!isInside(realRoot, real)) throw new Error('the path is outside the vault');
    return real;
  }

  private async ensureDir(relative: string): Promise<void> {
    const root = this.root;
    if (root === undefined) throw new Error('vault root is not configured');
    const full = this.resolve(relative);
    await this.fs.mkdir(full, 0o700);
    // mkdir's mode is cut by the umask, so every level is tightened explicitly, the root included.
    await this.fs.chmod(root, 0o700);
    let current = root;
    for (const segment of path.relative(root, full).split(path.sep)) {
      if (segment === '') continue;
      current = path.join(current, segment);
      await this.fs.chmod(current, 0o700);
    }
  }

  /** Writes one document folder and returns its files' root-relative paths. No root means index only. */
  async writeDoc(
    ymd: string,
    kind: DocKind,
    subject: string,
    mailId: string,
    files: readonly VaultFile[],
  ): Promise<string[]> {
    if (this.root === undefined) return [];
    const folder = [
      ymd,
      kind,
      safeName(subject) || 'mail',
      safeName(mailId.slice(0, 8)) || 'mail',
    ].join('-');
    const relativeDir = `${ymd.slice(0, 7)}/${folder}`;
    await this.ensureDir(relativeDir);

    const saved: string[] = [];
    for (const file of files) {
      const name = safeName(file.name) || 'file';
      const relative = `${relativeDir}/${name}`;
      const target = this.resolve(relative);
      await this.fs.writeFile(target, file.data, 0o600);
      await this.fs.chmod(target, 0o600);
      saved.push(relative);
    }
    return saved;
  }
}
