import { randomUUID } from 'node:crypto';
import type { DriveWriter } from '../../core/contracts/drive.js';
import type { GoogleRequestFn } from './http.js';

const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';
const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

interface FileList {
  files?: { id?: string }[];
}

function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/** Google Drive writes with the narrow `drive.file` scope: ax-kit sees and changes only the files it created. */
export class GoogleDriveWriter implements DriveWriter {
  private readonly folders = new Map<string, string>();

  constructor(private readonly request: GoogleRequestFn) {}

  async saveDocument(input: { name: string; markdown: string; folderName: string }, signal?: AbortSignal): Promise<{ id: string; url: string }> {
    const parent = await this.folder(input.folderName, signal);
    const boundary = `axkit-${randomUUID()}`;
    const metadata = { name: input.name.slice(0, 200), mimeType: DOC, parents: [parent] };
    // Markdown converts to a Google Doc with headings and lists
    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: text/markdown; charset=UTF-8',
      '',
      input.markdown,
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const created = await this.request<{ id?: string; webViewLink?: string }>(UPLOAD, {
      method: 'POST',
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      body,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (typeof created.id !== 'string') throw new Error('Google Drive did not return the new file');
    return { id: created.id, url: created.webViewLink ?? `https://docs.google.com/document/d/${created.id}/edit` };
  }

  private async folder(name: string, signal?: AbortSignal): Promise<string> {
    const known = this.folders.get(name);
    if (known !== undefined) return known;
    const q = `mimeType = ${quote(FOLDER)} and name = ${quote(name)} and trashed = false`;
    const found = await this.request<FileList>(`${FILES}?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`, signal !== undefined ? { signal } : {});
    let id = found.files?.[0]?.id;
    if (id === undefined) {
      const made = await this.request<{ id?: string }>(`${FILES}?fields=id`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, mimeType: FOLDER }),
        ...(signal !== undefined ? { signal } : {}),
      });
      id = made.id;
    }
    if (id === undefined) throw new Error('Could not make the Google Drive folder');
    this.folders.set(name, id);
    return id;
  }
}
