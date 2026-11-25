import type { FileEntry } from '../../core/contracts/files.js';
import { isSensitivePath } from '../../core/files/filter.js';
import type { GoogleRequestFn } from './http.js';
import { isRecord } from './json.js';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
const FIELDS = 'files(id,name,mimeType,size,modifiedTime),nextPageToken';
const MAX_PAGE = 1_000;

function toEntry(raw: unknown, exclude: readonly string[]): FileEntry | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '' || typeof raw.name !== 'string') return undefined;
  if (typeof raw.modifiedTime !== 'string' || Number.isNaN(Date.parse(raw.modifiedTime))) return undefined;
  const path = `Drive/${raw.name}`;
  if (isSensitivePath(path, exclude)) return undefined;
  const size = typeof raw.size === 'string' ? Number(raw.size) : typeof raw.size === 'number' ? raw.size : 0;
  return {
    id: raw.id,
    name: raw.name,
    path,
    ...(typeof raw.mimeType === 'string' ? { mimeType: raw.mimeType } : {}),
    size: Number.isFinite(size) ? size : 0,
    modifiedAt: raw.modifiedTime,
  };
}

/**
 * One page of every file the account can open: its own, shared with it, and shared drives; folders and trash left
 * out, sensitive names dropped. Metadata only. The first look walks it to the end, a page at a time.
 */
export async function everythingPage(
  request: GoogleRequestFn,
  exclude: readonly string[],
  opts: { pageToken?: string; pageSize?: number },
): Promise<{ entries: FileEntry[]; next?: string }> {
  const url = new URL(DRIVE_BASE);
  url.searchParams.set('q', `trashed = false and mimeType != '${FOLDER_MIME}'`);
  url.searchParams.set('fields', FIELDS);
  url.searchParams.set('pageSize', String(Math.min(Math.max(opts.pageSize ?? MAX_PAGE, 1), MAX_PAGE)));
  url.searchParams.set('orderBy', 'modifiedTime desc');
  url.searchParams.set('corpora', 'allDrives');
  url.searchParams.set('includeItemsFromAllDrives', 'true');
  url.searchParams.set('supportsAllDrives', 'true');
  if (opts.pageToken !== undefined) url.searchParams.set('pageToken', opts.pageToken);
  const payload = await request<{ files?: unknown[]; nextPageToken?: unknown }>(url.toString());
  const entries: FileEntry[] = [];
  for (const raw of payload.files ?? []) {
    const entry = toEntry(raw, exclude);
    if (entry !== undefined) entries.push(entry);
  }
  return { entries, ...(typeof payload.nextPageToken === 'string' && payload.nextPageToken !== '' ? { next: payload.nextPageToken } : {}) };
}

/** The bytes of a stored (non-Google) file such as a PDF or Word file, for conversion on this Mac. */
export async function fileBytes(
  request: GoogleRequestFn,
  requestBytes: (url: string) => Promise<Uint8Array>,
  exclude: readonly string[],
  id: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const meta = await request<{ name?: unknown; mimeType?: unknown; size?: unknown }>(`${DRIVE_BASE}/${encodeURIComponent(id)}?fields=name,mimeType,size&supportsAllDrives=true`);
  const name = typeof meta.name === 'string' ? meta.name : '';
  if (isSensitivePath(name, exclude)) throw new Error('The file name is not allowed by the current file rules.');
  if (typeof meta.mimeType === 'string' && meta.mimeType.startsWith(GOOGLE_APPS_PREFIX)) throw new Error('A Google file has no stored bytes; read its text instead.');
  const size = typeof meta.size === 'string' ? Number(meta.size) : 0;
  if (Number.isFinite(size) && size > maxBytes) throw new Error('The file is too large to read.');
  const bytes = await requestBytes(`${DRIVE_BASE}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
  if (bytes.byteLength > maxBytes) throw new Error('The file is too large to read.');
  return bytes;
}
