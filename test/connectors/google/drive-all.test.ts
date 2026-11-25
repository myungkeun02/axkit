import { describe, expect, it } from 'vitest';
import { GoogleDriveFiles } from '../../../src/connectors/google/drive.js';
import { DEFAULT_FILE_RULES } from '../../../src/core/files/filter.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';

const RULES = { ...DEFAULT_FILE_RULES, exclude: ['비밀'] };

describe('Drive: every file, page by page', () => {
  it('asks for every drive the account can open and passes the page token on', async () => {
    const urls: URL[] = [];
    const drive = new GoogleDriveFiles({
      request: async <T>(url: string): Promise<T> => {
        const parsed = new URL(url);
        urls.push(parsed);
        const page = parsed.searchParams.get('pageToken');
        return (page === null
          ? { files: [{ id: 'a', name: '조직도', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-11-20T00:00:00Z' }, { id: 'b', name: '비밀 메모', modifiedTime: '2026-11-20T00:00:00Z' }], nextPageToken: 't2' }
          : { files: [{ id: 'c', name: '보고.pdf', mimeType: 'application/pdf', size: '2048', modifiedTime: '2026-11-01T00:00:00Z' }] }) as T;
      },
      requestText: async () => '',
      rules: RULES,
      folderIds: [],
      log: silentLogger,
    });
    const first = await drive.everything({});
    expect(first.entries.map((entry) => entry.id)).toEqual(['a']);
    expect(first.next).toBe('t2');
    const second = await drive.everything({ pageToken: 't2' });
    expect(second).toEqual({ entries: [{ id: 'c', name: '보고.pdf', path: 'Drive/보고.pdf', mimeType: 'application/pdf', size: 2048, modifiedAt: '2026-11-01T00:00:00Z' }] });
    const params = urls[0]?.searchParams;
    expect(params?.get('corpora')).toBe('allDrives');
    expect(params?.get('includeItemsFromAllDrives')).toBe('true');
    expect(params?.get('supportsAllDrives')).toBe('true');
    expect(params?.get('q')).toBe("trashed = false and mimeType != 'application/vnd.google-apps.folder'");
    expect(urls[1]?.searchParams.get('pageToken')).toBe('t2');
  });

  it('downloads a stored file within the size limit and refuses Google files and big ones', async () => {
    const meta: Record<string, unknown> = { a: { name: 'a.pdf', mimeType: 'application/pdf', size: '3' }, g: { name: 'g', mimeType: 'application/vnd.google-apps.document' }, big: { name: 'big.pdf', mimeType: 'application/pdf', size: '999999' } };
    const drive = new GoogleDriveFiles({
      request: async <T>(url: string): Promise<T> => meta[new URL(url).pathname.split('/').at(-1) ?? ''] as T,
      requestText: async () => '',
      requestBytes: async () => new Uint8Array([1, 2, 3]),
      rules: RULES,
      folderIds: [],
      log: silentLogger,
    });
    expect([...(await drive.readBytes('a', 1000))]).toEqual([1, 2, 3]);
    await expect(drive.readBytes('g', 1000)).rejects.toThrow('Google file');
    await expect(drive.readBytes('big', 1000)).rejects.toThrow('too large');
  });
});
