import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';

export interface SessionFsEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface SessionFsStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

/** A session file found on disk; `id` is what the tool calls the session. */
export interface SessionFile {
  id: string;
  path: string;
  mtimeMs: number;
}

/** The read-only file calls the session readers need; tests may inject their own. Nothing here writes. */
export interface SessionFs {
  readdir(path: string): Promise<SessionFsEntry[]>;
  /** Never follows a symbolic link. */
  lstat(path: string): Promise<SessionFsStat>;
  /** The file's lines, streamed. Refuses a symbolic link. Breaking out of the loop stops reading. */
  lines(path: string): AsyncIterable<string>;
}

async function* nodeLines(path: string): AsyncIterable<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const input = handle.createReadStream({ encoding: 'utf8', autoClose: false });
    const rl = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of rl) yield line;
    } finally {
      rl.close();
      input.destroy();
    }
  } finally {
    await handle.close();
  }
}

export const nodeSessionFs: SessionFs = {
  async readdir(path) {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
    }));
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
  lines: nodeLines,
};

/** A directory listing, or nothing when the folder is missing or unreadable. */
export async function listDir(fs: SessionFs, path: string): Promise<SessionFsEntry[]> {
  try {
    return await fs.readdir(path);
  } catch {
    return [];
  }
}

/** A regular file's stat (not a link), or undefined. */
export async function regularFile(fs: SessionFs, path: string): Promise<SessionFsStat | undefined> {
  try {
    const info = await fs.lstat(path);
    return info.isFile && !info.isSymbolicLink ? info : undefined;
  } catch {
    return undefined;
  }
}

/** Each line parsed as a JSON object; malformed lines and non-objects are skipped. */
export async function* jsonLines(fs: SessionFs, path: string): AsyncIterable<Record<string, unknown>> {
  for await (const line of fs.lines(path)) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) yield parsed as Record<string, unknown>;
  }
}
