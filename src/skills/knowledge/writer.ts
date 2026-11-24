import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** The slice of node:fs/promises the writer needs; tests record modes and files through it. */
export interface DocFs {
  mkdir(path: string, mode: number): Promise<void>;
  writeFile(path: string, data: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readFile(path: string): Promise<string | undefined>;
  rm(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
}

export const NODE_DOC_FS: DocFs = {
  async mkdir(target, mode) {
    await mkdir(target, { recursive: true, mode });
  },
  async writeFile(target, data, mode) {
    await writeFile(target, data, { mode });
  },
  async rename(from, to) {
    await rename(from, to);
  },
  async readFile(target) {
    try {
      return await readFile(target, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  },
  async rm(target) {
    await rm(target, { force: true });
  },
  async chmod(target, mode) {
    await chmod(target, mode);
  },
};

const MAX_NAME = 60;
const FORBIDDEN = /[/\\:\p{Cc}]/gu;

/** A name that can only ever be one path segment. */
export function safeFileName(value: string): string {
  const cleaned = value
    .normalize('NFC')
    .replace(FORBIDDEN, ' ')
    .replace(/^[.\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME)
    .trim();
  return cleaned.length === 0 ? 'untitled' : cleaned;
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

const STAMP_LINE = /(?:갱신|Updated) (.+)$/m;

/** Markdown documents under one private folder: dirs 0700, files 0600, every path checked against the root. */
export class DocWriter {
  readonly root: string;
  private readonly fs: DocFs;

  constructor(root: string, fs: DocFs = NODE_DOC_FS) {
    this.root = path.resolve(root);
    this.fs = fs;
  }

  private resolve(relative: string): string {
    const target = path.resolve(this.root, relative);
    if (!isInside(this.root, target)) throw new Error('document path escapes the knowledge folder');
    return target;
  }

  /**
   * Rewrites only when the rendered content really changed. Rendering with the file's own stamp first keeps
   * the old timestamp when a run learned nothing new.
   */
  async writeStable(relPath: string, render: (stamp: string) => string, stamp: string): Promise<boolean> {
    const target = this.resolve(relPath);
    const current = await this.fs.readFile(target);
    if (current !== undefined) {
      const previous = STAMP_LINE.exec(current)?.[1];
      if (previous !== undefined && render(previous) === current) return false;
    }
    const next = render(stamp);
    if (next === current) return false;
    await this.atomicWrite(target, next);
    return true;
  }

  async writeText(relPath: string, text: string): Promise<boolean> {
    const target = this.resolve(relPath);
    const current = await this.fs.readFile(target);
    if (current === text) return false;
    await this.atomicWrite(target, text);
    return true;
  }

  read(relPath: string): Promise<string | undefined> {
    return this.fs.readFile(this.resolve(relPath));
  }

  async remove(relPath: string): Promise<boolean> {
    const target = this.resolve(relPath);
    if ((await this.fs.readFile(target)) === undefined) return false;
    await this.fs.rm(target);
    return true;
  }

  private async atomicWrite(target: string, data: string): Promise<void> {
    await this.ensureDir(path.dirname(target));
    const tmp = `${target}.tmp`;
    await this.fs.writeFile(tmp, data, 0o600);
    await this.fs.rename(tmp, target);
    // mkdir's and writeFile's modes are cut by the umask, so the final inode is tightened explicitly.
    await this.fs.chmod(target, 0o600);
  }

  private async ensureDir(dir: string): Promise<void> {
    await this.fs.mkdir(dir, 0o700);
    await this.fs.chmod(this.root, 0o700);
    let current = this.root;
    for (const segment of path.relative(this.root, dir).split(path.sep)) {
      if (segment === '') continue;
      current = path.join(current, segment);
      await this.fs.chmod(current, 0o700);
    }
  }
}
