import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** A throwaway home folder; tests never touch the real ~/.claude or ~/.codex. */
export async function tempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), 'axkit-sessions-'));
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

export async function writeLines(path: string, lines: readonly (object | string)[], mtimeSec?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  if (mtimeSec !== undefined) await utimes(path, mtimeSec, mtimeSec);
}

export async function link(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path);
}

export const TOKEN = 'sk-abcdefghijklmnopqrstuvwxyz0123';
