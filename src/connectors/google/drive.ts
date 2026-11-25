import type { FileEntry, FileSource } from '../../core/contracts/files.js';
import type { FileRules } from '../../core/files/filter.js';
import { fileVerdict, isSensitivePath } from '../../core/files/filter.js';
import type { Logger } from '../../core/log/types.js';
import type { GoogleRequestFn } from './http.js';
import { isRecord } from './json.js';
import { everythingPage, fileBytes } from './drive-all.js';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const SLIDES_MIME = 'application/vnd.google-apps.presentation';
const GOOGLE_APPS_PREFIX = 'application/vnd.google-apps.';
const FIELDS = 'files(id,name,mimeType,size,modifiedTime),nextPageToken';
const PAGE_SIZE = 1_000;
const MAX_PAGES = 20;
const MAX_DEPTH = 4;
const MAX_FILES = 2_000;
const FOLDER_ID = /^[A-Za-z0-9_-]+$/;

interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  size: number | undefined;
  modifiedAt: string;
}

interface QueryOptions {
  orderBy?: string;
  pageSize?: number;
  maxPages?: number;
}

export interface GoogleDriveFilesOptions {
  request: GoogleRequestFn;
  /** Fetches a body as plain text (export or alt=media). */
  requestText: (url: string, init?: RequestInit) => Promise<string>;
  /** Fetches a body as bytes (alt=media), for PDF and Word files converted on this Mac. */
  requestBytes?: (url: string) => Promise<Uint8Array>;
  rules: FileRules;
  folderIds: readonly string[];
  log: Logger;
  /** The file index tells sources apart by this; another account's Drive gets its own ("drive:a2"). */
  label?: string;
  /** Shown to the owner for this Drive (another account's address). */
  title?: string;
}

function toItem(raw: unknown): DriveItem | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.id !== 'string' || raw.id === '') return undefined;
  if (typeof raw.name !== 'string') return undefined;
  if (typeof raw.modifiedTime !== 'string' || raw.modifiedTime === '') return undefined;
  const size = typeof raw.size === 'string' ? Number(raw.size) : typeof raw.size === 'number' ? raw.size : undefined;
  return {
    id: raw.id,
    name: raw.name,
    mimeType: typeof raw.mimeType === 'string' ? raw.mimeType : '',
    size: size !== undefined && Number.isFinite(size) ? size : undefined,
    modifiedAt: raw.modifiedTime,
  };
}

function truncateBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  return buffer.subarray(0, Math.max(0, maxBytes)).toString('utf8');
}

/** Google Drive adapter over folders the owner configured. Read-only. */
export class GoogleDriveFiles implements FileSource {
  readonly label: string;
  readonly title?: string;

  constructor(private readonly deps: GoogleDriveFilesOptions) {
    this.label = deps.label ?? 'drive';
    if (deps.title !== undefined) this.title = deps.title;
  }

  async list(opts: { modifiedAfter?: Date; limit: number; oldestFirst?: boolean }): Promise<FileEntry[]> {
    if (opts.limit <= 0) return [];
    const found: FileEntry[] = [];
    const seen = new Set<string>();

    for (const folderId of this.deps.folderIds) {
      if (!FOLDER_ID.test(folderId)) {
        this.deps.log.warn('drive: skipped an invalid folder id');
        continue;
      }
      await this.walk(folderId, 'Drive', 0, opts, found, seen);
      if (found.length >= MAX_FILES) break;
    }

    const direction = opts.oldestFirst === true ? -1 : 1;
    found.sort(
      (left, right) => direction * right.modifiedAt.localeCompare(left.modifiedAt) || left.path.localeCompare(right.path),
    );
    return found.slice(0, opts.limit);
  }

  /** Recently changed files the owner owns anywhere in Drive; metadata only, any type. */
  async recent(opts: { modifiedAfter?: Date; limit: number }): Promise<FileEntry[]> {
    if (opts.limit <= 0) return [];
    const pageSize = Math.min(opts.limit, 200);
    const maxPages = Math.min(Math.ceil(opts.limit / pageSize), 5);
    const query = ['trashed = false', "'me' in owners", `mimeType != '${FOLDER_MIME}'`];
    if (opts.modifiedAfter !== undefined) query.push(`modifiedTime > '${opts.modifiedAfter.toISOString()}'`);

    const items = await this.query(query.join(' and '), {
      orderBy: 'modifiedTime desc',
      pageSize,
      maxPages,
    });
    const found: FileEntry[] = [];
    for (const item of items) {
      if (Number.isNaN(Date.parse(item.modifiedAt))) continue;
      const path = `Drive/${item.name}`;
      if (isSensitivePath(path, this.deps.rules.exclude)) continue;
      found.push({
        id: item.id,
        name: item.name,
        path,
        mimeType: item.mimeType,
        size: item.size ?? 0,
        modifiedAt: item.modifiedAt,
      });
      if (found.length >= opts.limit) break;
    }

    found.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.path.localeCompare(right.path));
    return found.slice(0, opts.limit);
  }

  /** Every file the account can open (own, shared, shared drives), a page at a time. */
  async everything(opts: { pageToken?: string; pageSize?: number }): Promise<{ entries: FileEntry[]; next?: string }> {
    return await everythingPage(this.deps.request, this.deps.rules.exclude, opts);
  }

  async readBytes(id: string, maxBytes: number): Promise<Uint8Array> {
    const requestBytes = this.deps.requestBytes;
    if (requestBytes === undefined) throw new Error('This Drive cannot download files.');
    return await fileBytes(this.deps.request, requestBytes, this.deps.rules.exclude, id, maxBytes);
  }

  async readText(id: string, maxBytes: number): Promise<string> {
    if (maxBytes <= 0) return '';
    const meta = await this.deps.request<{ id?: unknown; name?: unknown; mimeType?: unknown }>(
      `${DRIVE_BASE}/${encodeURIComponent(id)}?fields=id,name,mimeType&supportsAllDrives=true`,
    );
    const name = typeof meta.name === 'string' ? meta.name : '';
    if (isSensitivePath(name, this.deps.rules.exclude)) {
      throw new Error('The file name is not allowed by the current file rules.');
    }
    const mimeType = typeof meta.mimeType === 'string' ? meta.mimeType : '';
    if (mimeType === DOC_MIME) {
      return truncateBytes(await this.deps.requestText(this.exportUrl(id, 'text/plain')), maxBytes);
    }
    if (mimeType === SHEET_MIME) {
      return truncateBytes(await this.deps.requestText(this.exportUrl(id, 'text/csv')), maxBytes);
    }
    if (mimeType === SLIDES_MIME) {
      return truncateBytes(await this.deps.requestText(this.exportUrl(id, 'text/plain')), maxBytes);
    }
    if (mimeType.startsWith(GOOGLE_APPS_PREFIX)) throw new Error('This Google Drive file type has no readable text.');
    if (!this.deps.rules.extensions.includes(this.extensionOf(name))) {
      throw new Error('The file type is not allowed by the current file rules.');
    }
    return truncateBytes(
      await this.deps.requestText(`${DRIVE_BASE}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`),
      maxBytes,
    );
  }

  private extensionOf(name: string): string {
    const dot = name.lastIndexOf('.');
    return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
  }

  private exportUrl(id: string, mimeType: string): string {
    const url = new URL(`${DRIVE_BASE}/${encodeURIComponent(id)}/export`);
    url.searchParams.set('mimeType', mimeType);
    url.searchParams.set('supportsAllDrives', 'true');
    return url.toString();
  }

  private async walk(
    folderId: string,
    pathPrefix: string,
    depth: number,
    opts: { modifiedAfter?: Date; limit: number },
    found: FileEntry[],
    seen: Set<string>,
  ): Promise<void> {
    if (found.length >= MAX_FILES) return;

    const fileQuery = [`'${folderId}' in parents`, 'trashed = false', `mimeType != '${FOLDER_MIME}'`];
    if (opts.modifiedAfter !== undefined) fileQuery.push(`modifiedTime > '${opts.modifiedAfter.toISOString()}'`);
    for (const item of await this.query(fileQuery.join(' and '))) {
      if (found.length >= MAX_FILES) break;
      const entry = this.toEntry(item, pathPrefix, opts.modifiedAfter);
      if (entry === undefined || seen.has(entry.id)) continue;
      seen.add(entry.id);
      found.push(entry);
    }

    if (depth >= MAX_DEPTH) return;
    const folderQuery = [`'${folderId}' in parents`, 'trashed = false', `mimeType = '${FOLDER_MIME}'`];
    for (const item of await this.query(folderQuery.join(' and '))) {
      if (found.length >= MAX_FILES) break;
      if (!FOLDER_ID.test(item.id)) {
        this.deps.log.warn('drive: skipped a folder with an unexpected id');
        continue;
      }
      await this.walk(item.id, `${pathPrefix}/${item.name}`, depth + 1, opts, found, seen);
    }
  }

  private toEntry(item: DriveItem, pathPrefix: string, modifiedAfter: Date | undefined): FileEntry | undefined {
    const path = `${pathPrefix}/${item.name}`;
    const modified = Date.parse(item.modifiedAt);
    if (Number.isNaN(modified)) return undefined;
    if (modifiedAfter !== undefined && modified <= modifiedAfter.getTime()) return undefined;
    if (isSensitivePath(path, this.deps.rules.exclude)) return undefined;

    const native = item.mimeType.startsWith(GOOGLE_APPS_PREFIX);
    if (native && item.mimeType !== DOC_MIME && item.mimeType !== SHEET_MIME) return undefined;
    const size = item.size ?? 0;
    if (!native && fileVerdict(path, size, this.deps.rules) !== 'ok') return undefined;

    return { id: item.id, name: item.name, path, mimeType: item.mimeType, size, modifiedAt: item.modifiedAt };
  }

  private async query(q: string, opts: QueryOptions = {}): Promise<DriveItem[]> {
    const items: DriveItem[] = [];
    const pageSize = opts.pageSize ?? PAGE_SIZE;
    const maxPages = opts.maxPages ?? MAX_PAGES;
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL(DRIVE_BASE);
      url.searchParams.set('q', q);
      url.searchParams.set('fields', FIELDS);
      url.searchParams.set('pageSize', String(pageSize));
      if (opts.orderBy !== undefined) url.searchParams.set('orderBy', opts.orderBy);
      if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
      const payload = await this.deps.request<{ files?: unknown[]; nextPageToken?: unknown }>(url.toString());
      for (const raw of payload.files ?? []) {
        const item = toItem(raw);
        if (item !== undefined) items.push(item);
      }
      pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : undefined;
      if (pageToken === undefined) break;
    }
    return items;
  }
}
