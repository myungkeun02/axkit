import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';

export interface LocalFsEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface LocalFsStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** The file-system calls the local-files connector needs; tests inject an in-memory tree. */
export interface LocalFs {
  readdir(path: string): Promise<LocalFsEntry[]>;
  stat(path: string): Promise<LocalFsStat>;
  lstat(path: string): Promise<LocalFsStat>;
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
}

export const nodeLocalFs: LocalFs = {
  async readdir(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
  },
  async stat(path) {
    const info = await stat(path);
    return {
      size: info.size,
      mtimeMs: info.mtimeMs,
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      isSymbolicLink: info.isSymbolicLink(),
    };
  },
  async lstat(path) {
    const info = await lstat(path);
    return {
      size: info.size,
      mtimeMs: info.mtimeMs,
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      isSymbolicLink: info.isSymbolicLink(),
    };
  },
  realpath: (path) => realpath(path),
  readFile: (path) => readFile(path),
};
