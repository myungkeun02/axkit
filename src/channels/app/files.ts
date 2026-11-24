import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import type { DeviceFile } from '../../core/contracts/device-api.js';
import { AppShareError } from '../../core/contracts/files.js';
import type { OutgoingImage } from '../../core/conversation/types.js';
import type { Clock } from '../../core/scheduler/types.js';
import { extensionOf } from '../../core/files/filter.js';
import { SHARE_CONTENT_TYPES, SHARE_FORMATS, SHARE_MAX_BYTES } from '../../core/files/share-types.js';
import type { AttachmentView, EventMedia } from './protocol.js';

/** §7.5 file ids; the router already refuses `/` and dot-only segments, this is checked again here. */
export const FILE_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
/** Chat history keeps showing its pictures and documents for a month; the folder never grows past 1 GB. */
export const KEEP_DAYS = 30;
const KEEP_MS = KEEP_DAYS * 24 * 60 * 60_000;
const MAX_FOLDER_BYTES = 1024 * 1024 * 1024;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const HTTPS_URL = /^https:\/\/[^\s"'<>]{1,2000}$/i;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
};

/** The picture format from its first bytes, so only real images are ever copied in and served. */
export function sniffImage(bytes: Buffer): keyof typeof CONTENT_TYPES | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'mif1', 'msf1'].includes(brand)) return 'heic';
  }
  return undefined;
}

const ZIP = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06])];
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const TEXT_PROBE = 8_192;

/** Whether the bytes really are what the extension says, so a renamed program is never served as a document. */
export function looksLike(ext: string, bytes: Buffer): boolean {
  switch (SHARE_FORMATS[ext]) {
    case 'pdf':
      return bytes.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'image': {
      const kind = sniffImage(bytes);
      return kind !== undefined && (kind === ext || (kind === 'jpg' && ext === 'jpeg'));
    }
    case 'zip':
      return ZIP.some((magic) => bytes.subarray(0, 4).equals(magic));
    case 'ole':
      return bytes.subarray(0, 8).equals(OLE);
    case 'text':
      return !bytes.subarray(0, TEXT_PROBE).includes(0);
    default:
      return false;
  }
}

/** Why a document could not be copied in; `reason` lets the skill say it in the owner's language. */
export class AppFileError extends AppShareError {}

export function isHttpsImageUrl(url: string): boolean {
  return HTTPS_URL.test(url.trim());
}

/**
 * Pictures the server sends to the app (§7.5): copied into one private folder under ~/.ax-kit and served at
 * `files/<id>` with the app's own token. Files live 30 days (1 GB at most, oldest go first); those of a still-open
 * card stay until it closes.
 */
export class AppFiles {
  private readonly root: string;

  constructor(
    dir: string,
    private readonly clock: Clock,
    private readonly random: (size: number) => Buffer = randomBytes,
  ) {
    this.root = resolve(dir);
  }

  /** A local image → an attachment; anything that is not a readable image under the size cap is skipped. */
  async addImage(image: { path: string; name?: string }): Promise<AttachmentView | undefined> {
    let bytes: Buffer;
    try {
      const real = await realpath(image.path);
      const info = await stat(real);
      if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) return undefined;
      bytes = await readFile(real);
    } catch {
      return undefined;
    }
    const kind = sniffImage(bytes);
    if (kind === undefined) return undefined;
    await mkdir(this.root, { recursive: true, mode: DIR_MODE });
    await chmod(this.root, DIR_MODE);
    const id = `img_${this.random(12).toString('hex')}.${kind}`;
    const target = join(this.root, id);
    await writeFile(target, bytes, { mode: FILE_MODE, flag: 'wx' });
    await chmod(target, FILE_MODE);
    const name = cleanName(image.name ?? basename(image.path)) || id;
    return { id, name, contentType: CONTENT_TYPES[kind] ?? 'application/octet-stream', size: bytes.length, url: `files/${id}` };
  }

  /**
   * §19: a document the assistant sends to the owner (pdf, picture, office file, txt/md, zip; 20 MB at most). The
   * bytes must match the extension; the copy lives as long as pictures.
   */
  async addDocument(file: { path: string; name?: string }): Promise<AttachmentView> {
    const ext = extensionOf(file.name ?? basename(file.path));
    const contentType = SHARE_CONTENT_TYPES[ext];
    if (contentType === undefined) throw new AppFileError('type', 'This kind of file cannot be sent to the app.');
    let bytes: Buffer;
    try {
      const real = await realpath(file.path);
      const info = await stat(real);
      if (!info.isFile() || info.size === 0) throw new AppFileError('not-file', 'The file is empty or not a regular file.');
      if (info.size > SHARE_MAX_BYTES) throw new AppFileError('size', 'The file is larger than 20 MB.');
      bytes = await readFile(real);
    } catch (error) {
      throw error instanceof AppFileError ? error : new AppFileError('unreadable', 'The file could not be read.');
    }
    if (bytes.length > SHARE_MAX_BYTES) throw new AppFileError('size', 'The file is larger than 20 MB.');
    if (!looksLike(ext, bytes)) throw new AppFileError('mismatch', 'The file contents do not match its type.');
    await mkdir(this.root, { recursive: true, mode: DIR_MODE });
    await chmod(this.root, DIR_MODE);
    const id = `doc_${this.random(12).toString('hex')}.${ext}`;
    const target = join(this.root, id);
    await writeFile(target, bytes, { mode: FILE_MODE, flag: 'wx' });
    await chmod(target, FILE_MODE);
    const name = cleanName(file.name ?? basename(file.path)) || id;
    return { id, name, contentType, size: bytes.length, url: `files/${id}` };
  }

  /** `GET files/<id>`: only plain files directly in the folder; ids that could leave it answer nothing. */
  async read(id: string): Promise<DeviceFile | undefined> {
    if (!FILE_ID.test(id) || /^\.+$/.test(id) || basename(id) !== id) return undefined;
    const path = join(this.root, id);
    if (!path.startsWith(`${this.root}${sep}`)) return undefined;
    const kind = id.slice(id.lastIndexOf('.') + 1);
    const contentType = id.startsWith('doc_') ? SHARE_CONTENT_TYPES[kind] : CONTENT_TYPES[kind];
    if (contentType === undefined) return undefined;
    try {
      const info = await lstat(path);
      if (!info.isFile()) return undefined;
      return { bytes: await readFile(path), contentType, name: id };
    } catch {
      return undefined;
    }
  }

  /** Message / card pictures → event fields: local files become attachments, the first https address `imageUrl`. */
  async media(images: readonly OutgoingImage[] | undefined): Promise<EventMedia> {
    const attachments: AttachmentView[] = [];
    let imageUrl: string | undefined;
    for (const image of images ?? []) {
      if ('url' in image) {
        if (imageUrl === undefined && isHttpsImageUrl(image.url)) imageUrl = image.url.trim();
        continue;
      }
      if (attachments.length >= MAX_ATTACHMENTS) continue;
      const added = await this.addImage(image).catch(() => undefined);
      if (added !== undefined) attachments.push(added);
    }
    return { ...(attachments.length > 0 ? { attachments } : {}), ...(imageUrl !== undefined ? { imageUrl } : {}) };
  }

  /**
   * Removes files older than 30 days, then the oldest ones while the folder is over 1 GB; never `keep` (pictures of
   * cards that are still open).
   */
  async prune(keep: ReadonlySet<string>, maxBytes = MAX_FOLDER_BYTES): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return 0;
    }
    const cutoff = this.clock.now().getTime() - KEEP_MS;
    const files: { path: string; at: number; size: number }[] = [];
    for (const name of names) {
      if (keep.has(name) || !FILE_ID.test(name)) continue;
      const path = join(this.root, name);
      const info = await lstat(path).catch(() => undefined);
      if (info?.isFile() === true) files.push({ path, at: info.mtimeMs, size: info.size });
    }
    files.sort((a, b) => a.at - b.at);
    let total = files.reduce((sum, file) => sum + file.size, 0);
    let removed = 0;
    for (const file of files) {
      if (file.at >= cutoff && total <= maxBytes) break;
      try {
        await rm(file.path, { force: true });
        removed += 1;
        total -= file.size;
      } catch {
        // already gone
      }
    }
    return removed;
  }
}

/** Without a files folder pictures that are local files are dropped; https addresses still go through. */
export async function mediaWithoutFiles(images: readonly OutgoingImage[] | undefined): Promise<EventMedia> {
  const url = (images ?? []).flatMap((image) => ('url' in image && isHttpsImageUrl(image.url) ? [image.url.trim()] : []))[0];
  return url !== undefined ? { imageUrl: url } : {};
}

function cleanName(raw: string): string {
  return [...raw]
    .filter((character) => (character.codePointAt(0) ?? 0) >= 0x20 && !'/\\:'.includes(character))
    .join('')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
}
