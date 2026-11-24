import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { DraftAttachment } from '../../core/contracts/mail.js';
import { isExcludedHomePath, relativeToHome } from '../../core/files/home.js';

/** Gmail takes the whole message in one request: keep all files of one draft under this. */
export const MAX_ATTACH_BYTES = 7_000_000;
export const MAX_ATTACH_FILES = 5;

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwp: 'application/x-hwp',
  hwpx: 'application/haansofthwpx',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  zip: 'application/zip',
  key: 'application/x-iwork-keynote-sffkey',
  pages: 'application/x-iwork-pages-sffpages',
};

export function mimeOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return TYPES[dot < 0 ? '' : name.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Reads files to attach. Only "~/…" paths inside home that no exclusion covers (keys, app data, hidden folders), plain
 * files, no symlinks, within the size limit. Throws with a plain reason otherwise.
 */
export async function readAttachments(paths: readonly string[], home = homedir()): Promise<DraftAttachment[]> {
  if (paths.length > MAX_ATTACH_FILES) throw new Error(`At most ${MAX_ATTACH_FILES} files can be attached.`);
  const realHome = await realpath(home).catch(() => home);
  const out: DraftAttachment[] = [];
  let total = 0;
  for (const raw of paths) {
    if (!raw.startsWith('~/')) throw new Error(`Attach files by their "~/…" path: ${raw}`);
    const absolute = join(realHome, raw.slice(2));
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Not a plain file: ${raw}`);
    const real = await realpath(absolute);
    const rel = relativeToHome(real, realHome);
    if (rel === undefined || isExcludedHomePath(rel)) throw new Error(`That file cannot be attached: ${raw}`);
    total += info.size;
    if (total > MAX_ATTACH_BYTES) throw new Error('The files are too large to attach together (7MB at most).');
    const name = basename(real);
    out.push({ filename: name, mimeType: mimeOf(name), data: new Uint8Array(await readFile(real)) });
  }
  return out;
}
