import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The file access an LLM coder needs, injected so tests never touch a real worktree. */
export interface CoderFs {
  read(path: string, maxBytes: number): Promise<string | undefined>;
  write(path: string, content: string): Promise<void>;
}

function isBinary(data: Uint8Array): boolean {
  return data.includes(0);
}

export const nodeCoderFs: CoderFs = {
  async read(path, maxBytes) {
    try {
      const data = await readFile(path);
      if (isBinary(data)) return undefined;
      const slice = data.length > maxBytes ? data.subarray(0, maxBytes) : data;
      return slice.toString('utf8');
    } catch {
      return undefined;
    }
  },
  async write(path, content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
  },
};
