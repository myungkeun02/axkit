import { open, realpath, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { DEFAULT_FILE_RULES, extensionOf } from '../../core/files/filter.js';
import { expandHome, isExcludedHomePath, relativeToHome } from '../../core/files/home.js';
import type { HomeFileReason } from './locale.js';

export class HomeFileError extends Error {
  override readonly name = 'HomeFileError';
  constructor(readonly reason: HomeFileReason) {
    super(reason);
  }
}

export interface HomeFile {
  /** The resolved path. */
  real: string;
  /** Below home, "/"-separated. */
  rel: string;
  name: string;
  size: number;
  mtimeMs: number;
}

async function realHome(home: string): Promise<string> {
  try {
    return await realpath(home);
  } catch {
    return home;
  }
}

/**
 * A path the owner or a search gave ("~/a.pdf" or absolute) → a regular file under home that no exclusion rule
 * covers, checked both as asked and after links are resolved.
 */
export async function resolveHomeFile(path: string, home: string): Promise<HomeFile> {
  const asked = expandHome(path, home);
  if (asked === undefined) throw new HomeFileError('not-home');
  const askedRel = relativeToHome(asked, home);
  if (askedRel === undefined) throw new HomeFileError('not-home');
  if (isExcludedHomePath(askedRel)) throw new HomeFileError('excluded');

  let real: string;
  try {
    real = await realpath(asked);
  } catch {
    throw new HomeFileError('missing');
  }
  const rel = relativeToHome(real, await realHome(home)) ?? relativeToHome(real, home);
  if (rel === undefined) throw new HomeFileError('not-home');
  if (isExcludedHomePath(rel)) throw new HomeFileError('excluded');

  const info = await stat(real);
  if (!info.isFile()) throw new HomeFileError('not-file');
  return { real, rel, name: basename(real), size: info.size, mtimeMs: info.mtimeMs };
}

/** Text of a file under home: text types only, under the folder rules' size cap, never binary. */
export async function readHomeText(path: string, home: string, maxBytes: number): Promise<string> {
  const file = await resolveHomeFile(path, home);
  if (!DEFAULT_FILE_RULES.extensions.includes(extensionOf(file.name))) throw new HomeFileError('type');
  if (file.size > DEFAULT_FILE_RULES.maxBytes) throw new HomeFileError('size');
  const handle = await open(file.real, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, Math.min(maxBytes, file.size)));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.includes(0)) throw new HomeFileError('binary');
    return bytes.toString('utf8');
  } finally {
    await handle.close();
  }
}
