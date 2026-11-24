import { basename, dirname, join } from 'node:path';
import type { LocalFs, LocalFsEntry, LocalFsStat } from '../../../src/connectors/local-files/fs.js';
import type { Logger } from '../../../src/core/log/types.js';

export interface CaptureLogger extends Logger {
  readonly warnings: string[];
}

export function captureLogger(): CaptureLogger {
  const warnings: string[] = [];
  const noop = (): void => undefined;
  const logger: CaptureLogger = {
    warnings,
    debug: noop,
    info: noop,
    warn: (msg) => {
      warnings.push(msg);
    },
    error: noop,
    child: () => logger,
  };
  return logger;
}

interface FakeNode {
  kind: 'file' | 'dir' | 'symlink';
  content?: string;
  mtimeMs: number;
  target?: string;
}

/** In-memory file system: absolute paths, symlinks resolved like node's realpath. */
export class FakeLocalFs implements LocalFs {
  private readonly nodes = new Map<string, FakeNode>();

  addDir(path: string, mtimeMs = 0): this {
    const parent = dirname(path);
    if (parent !== path && !this.nodes.has(parent)) this.addDir(parent, mtimeMs);
    this.nodes.set(path, { kind: 'dir', mtimeMs });
    return this;
  }

  addFile(path: string, content: string, mtimeMs = 0): this {
    this.addDir(dirname(path), mtimeMs);
    this.nodes.set(path, { kind: 'file', content, mtimeMs });
    return this;
  }

  addSymlink(path: string, target: string, mtimeMs = 0): this {
    this.addDir(dirname(path), mtimeMs);
    this.nodes.set(path, { kind: 'symlink', target, mtimeMs });
    return this;
  }

  private get(path: string): FakeNode {
    const node = this.nodes.get(path);
    if (node === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return node;
  }

  async readdir(path: string): Promise<LocalFsEntry[]> {
    this.get(path);
    const entries: LocalFsEntry[] = [];
    for (const [candidate, node] of this.nodes) {
      if (dirname(candidate) !== path) continue;
      entries.push({
        name: basename(candidate),
        isFile: node.kind === 'file',
        isDirectory: node.kind === 'dir',
        isSymbolicLink: node.kind === 'symlink',
      });
    }
    return entries;
  }

  private info(node: FakeNode): LocalFsStat {
    return {
      size: Buffer.byteLength(node.content ?? ''),
      mtimeMs: node.mtimeMs,
      isFile: node.kind === 'file',
      isDirectory: node.kind === 'dir',
      isSymbolicLink: node.kind === 'symlink',
    };
  }

  async lstat(path: string): Promise<LocalFsStat> {
    return this.info(this.get(path));
  }

  async stat(path: string): Promise<LocalFsStat> {
    const node = this.get(path);
    if (node.kind === 'symlink') return this.stat(this.resolve(node));
    return this.info(node);
  }

  async realpath(path: string): Promise<string> {
    const parent = dirname(path);
    if (parent === path) {
      this.get(path);
      return path;
    }
    const resolvedParent = await this.realpath(parent);
    const node = this.get(join(resolvedParent, basename(path)));
    if (node.kind === 'symlink') return this.realpath(this.resolve(node));
    return join(resolvedParent, basename(path));
  }

  async readFile(path: string): Promise<Uint8Array> {
    const node = this.get(path);
    if (node.kind === 'symlink') return this.readFile(this.resolve(node));
    if (node.kind !== 'file') throw new Error(`EISDIR: ${path}`);
    return Buffer.from(node.content ?? '');
  }

  private resolve(node: FakeNode): string {
    if (node.target === undefined) throw new Error('broken symlink');
    return node.target;
  }
}
