import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeviceUpload } from '../../core/contracts/device-api.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface SavedShare {
  path: string;
  kind: 'image' | 'audio' | 'file';
}

export function shareKind(contentType: string): SavedShare['kind'] {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'file';
}

/** Shared files land in a private inbox by month; names are already path-free (bridge `safeFileName`). */
export async function saveShare(inboxDir: string, upload: DeviceUpload, now: Date): Promise<SavedShare> {
  const month = now.toISOString().slice(0, 7);
  const dir = join(inboxDir, month);
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  // umask can widen the mode on create, so it is set again.
  await chmod(dir, DIR_MODE);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${stamp}-${upload.name}`);
  await writeFile(path, upload.bytes, { mode: FILE_MODE, flag: 'wx' });
  await chmod(path, FILE_MODE);
  return { path, kind: shareKind(upload.contentType) };
}
