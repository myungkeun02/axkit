import { describe, expect, it } from 'vitest';
import { GoogleDriveFiles } from '../../../src/connectors/google/drive.js';
import { googleDriveConnector } from '../../../src/connectors/google/drive-plugin.js';
import type { GoogleRequestFn } from '../../../src/connectors/google/http.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { DEFAULT_FILE_RULES } from '../../../src/core/files/filter.js';
import type { Logger } from '../../../src/core/log/types.js';
import { createTestContext } from '../../support/context.js';
import { fakeFetch, json } from './helpers.js';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const RULES = { ...DEFAULT_FILE_RULES, maxBytes: 1_000_000, exclude: [] as string[] };

interface CaptureLogger extends Logger {
  readonly warnings: string[];
}

function captureLogger(): CaptureLogger {
  const warnings: string[] = [];
  const noop = (): void => undefined;
  const logger: CaptureLogger = {
    warnings,
    debug: noop,
    info: noop,
    warn: (msg) => {
      warnings.push(msg);
    },
    error: noop,
    child: () => logger,
  };
  return logger;
}

function fakeJson(handler: (url: URL) => unknown): { request: GoogleRequestFn; urls: URL[] } {
  const urls: URL[] = [];
  const request = async <T>(url: string): Promise<T> => {
    const parsed = new URL(url);
    urls.push(parsed);
    return handler(parsed) as T;
  };
  return { request, urls };
}

function fakeText(handler: (url: URL) => string): { requestText: (url: string) => Promise<string>; urls: URL[] } {
  const urls: URL[] = [];
  const requestText = async (url: string): Promise<string> => {
    const parsed = new URL(url);
    urls.push(parsed);
    return handler(parsed);
  };
  return { requestText, urls };
}

function item(id: string, name: string, mimeType: string, modifiedTime: string, size?: string): Record<string, unknown> {
  return { id, name, mimeType, modifiedTime, ...(size !== undefined ? { size } : {}) };
}

const ROOT_FILES = [
  item('doc-1', 'notes', 'application/vnd.google-apps.document', '2026-11-17T05:00:00.000Z'),
  item('sheet-1', 'report', 'application/vnd.google-apps.spreadsheet', '2026-11-17T04:00:00.000Z'),
  item('txt-1', 'readme.txt', 'text/plain', '2026-11-17T03:00:00.000Z', '12'),
  item('pdf-1', 'plan.pdf', 'application/pdf', '2026-11-17T02:00:00.000Z', '10'),
  item('env-1', '.env', 'text/plain', '2026-11-17T01:00:00.000Z', '5'),
  item('slides-1', 'slides', 'application/vnd.google-apps.presentation', '2026-11-17T01:00:00.000Z'),
];
const FOLDER = item('folder-1', 'Sub', FOLDER_MIME, '2026-11-17T00:00:00.000Z');
const NESTED = [item('nested-1', 'deep.md', 'text/markdown', '2026-11-17T06:00:00.000Z', '8')];

function listHandler(url: URL): unknown {
  const q = url.searchParams.get('q') ?? '';
  if (q.includes(`mimeType = '${FOLDER_MIME}'`)) {
    return { files: q.includes("'root-1' in parents") ? [FOLDER] : [] };
  }
  if (q.includes("'root-1' in parents")) return { files: ROOT_FILES };
  if (q.includes("'folder-1' in parents")) return { files: NESTED };
  return { files: [] };
}

describe('GoogleDriveFiles.list', () => {
  it('walks folders and keeps docs, sheets and allowed text files', async () => {
    const { request, urls } = fakeJson(listHandler);
    const drive = new GoogleDriveFiles({
      request,
      requestText: async () => '',
      rules: RULES,
      folderIds: ['root-1'],
      log: captureLogger(),
    });

    const listed = await drive.list({ limit: 20 });

    expect(listed.map((entry) => entry.path)).toEqual([
      'Drive/Sub/deep.md',
      'Drive/notes',
      'Drive/report',
      'Drive/readme.txt',
    ]);
    expect(listed[1]).toMatchObject({ id: 'doc-1', name: 'notes', size: 0 });
    expect(urls[0]?.searchParams.get('fields')).toBe(
      'files(id,name,mimeType,size,modifiedTime),nextPageToken',
    );
    expect(urls[0]?.searchParams.get('q')).toContain("mimeType != 'application/vnd.google-apps.folder'");
    expect(urls[1]?.searchParams.get('q')).toContain(`mimeType = '${FOLDER_MIME}'`);
  });

  it('adds the modifiedTime filter to file queries only', async () => {
    const { request, urls } = fakeJson(listHandler);
    const drive = new GoogleDriveFiles({
      request,
      requestText: async () => '',
      rules: RULES,
      folderIds: ['root-1'],
      log: captureLogger(),
    });

    await drive.list({ modifiedAfter: new Date('2026-11-01T00:00:00.000Z'), limit: 20 });

    const fileQuery = urls[0]?.searchParams.get('q') ?? '';
    expect(fileQuery).toContain("modifiedTime > '2026-11-01T00:00:00.000Z'");
    const folderQuery = urls[1]?.searchParams.get('q') ?? '';
    expect(folderQuery).not.toContain('modifiedTime');
  });

  it('skips invalid folder ids with a warning and lists nothing for no folders', async () => {
    const { request, urls } = fakeJson(listHandler);
    const log = captureLogger();
    const drive = new GoogleDriveFiles({
      request,
      requestText: async () => '',
      rules: RULES,
      folderIds: ['bad/id', 'bad id'],
      log,
    });

    await expect(drive.list({ limit: 5 })).resolves.toEqual([]);
    expect(urls).toHaveLength(0);
    expect(log.warnings).toEqual(['drive: skipped an invalid folder id', 'drive: skipped an invalid folder id']);

    const empty = new GoogleDriveFiles({
      request,
      requestText: async () => '',
      rules: RULES,
      folderIds: [],
      log: captureLogger(),
    });
    await expect(empty.list({ limit: 5 })).resolves.toEqual([]);
  });
});

const RECENT = [
  item('doc-1', 'notes', 'application/vnd.google-apps.document', '2026-11-17T08:00:00.000Z'),
  item('report-1', 'report.md', 'text/markdown', '2026-11-17T07:00:00.000Z', '9'),
  item('fresh-1', 'fresh.md', 'text/markdown', '2026-11-17T06:00:00.000Z', '8'),
  item('secret-1', '비밀번호.txt', 'text/plain', '2026-11-17T05:30:00.000Z', '3'),
  item('broken-1', 'broken.txt', 'text/plain', 'not-a-date', '1'),
];

function driveForRecent(handler: () => unknown) {
  const fake = fakeJson(handler);
  const drive = new GoogleDriveFiles({
    request: fake.request,
    requestText: async () => '',
    rules: RULES,
    folderIds: [],
    log: captureLogger(),
  });
  return { drive, urls: fake.urls };
}

describe('GoogleDriveFiles.recent', () => {
  it("queries the owner's recent files newest first and skips sensitive or malformed ones", async () => {
    const { drive, urls } = driveForRecent(() => ({ files: RECENT }));

    const listed = await drive.recent({ modifiedAfter: new Date('2026-11-01T00:00:00.000Z'), limit: 10 });

    expect(listed.map((entry) => entry.path)).toEqual(['Drive/notes', 'Drive/report.md', 'Drive/fresh.md']);
    expect(listed[0]).toMatchObject({
      id: 'doc-1',
      mimeType: 'application/vnd.google-apps.document',
      size: 0,
      modifiedAt: '2026-11-17T08:00:00.000Z',
    });

    const q = urls[0]?.searchParams.get('q') ?? '';
    expect(q).toContain('trashed = false');
    expect(q).toContain("'me' in owners");
    expect(q).toContain(`mimeType != '${FOLDER_MIME}'`);
    expect(q).toContain("modifiedTime > '2026-11-01T00:00:00.000Z'");
    expect(urls[0]?.searchParams.get('orderBy')).toBe('modifiedTime desc');
    expect(urls[0]?.searchParams.get('pageSize')).toBe('10');
  });

  it('honours the limit and asks for at most one page when the limit fits', async () => {
    const { drive, urls } = driveForRecent(() => ({ files: RECENT, nextPageToken: 'next' }));

    const listed = await drive.recent({ limit: 2 });

    expect(listed.map((entry) => entry.path)).toEqual(['Drive/notes', 'Drive/report.md']);
    expect(urls).toHaveLength(1);
    expect(urls[0]?.searchParams.get('pageSize')).toBe('2');
  });

  it('never fetches more than five pages', async () => {
    const { drive, urls } = driveForRecent(() => ({ files: RECENT, nextPageToken: 'next' }));

    await drive.recent({ limit: 2_000 });

    expect(urls).toHaveLength(5);
    expect(urls[0]?.searchParams.get('pageSize')).toBe('200');
  });

  it('returns nothing for a non-positive limit', async () => {
    const { drive, urls } = driveForRecent(() => ({ files: RECENT }));

    await expect(drive.recent({ limit: 0 })).resolves.toEqual([]);
    expect(urls).toHaveLength(0);
  });
});

describe('GoogleDriveFiles.readText', () => {
  function driveFor(meta: Record<string, unknown>, body: string) {
    const json = fakeJson(() => meta);
    const text = fakeText(() => body);
    const drive = new GoogleDriveFiles({
      request: json.request,
      requestText: text.requestText,
      rules: RULES,
      folderIds: [],
      log: captureLogger(),
    });
    return { drive, text };
  }

  it('exports Google Docs as plain text and truncates to maxBytes', async () => {
    const { drive, text } = driveFor(
      { id: 'doc-1', name: 'notes', mimeType: 'application/vnd.google-apps.document' },
      'abcdefgh',
    );

    await expect(drive.readText('doc-1', 4)).resolves.toBe('abcd');
    expect(text.urls[0]?.pathname).toBe('/drive/v3/files/doc-1/export');
    expect(text.urls[0]?.searchParams.get('mimeType')).toBe('text/plain');
  });

  it('exports Google Sheets as CSV and reads plain files with alt=media', async () => {
    const sheet = driveFor({ name: 'report', mimeType: 'application/vnd.google-apps.spreadsheet' }, 'a,b');
    await expect(sheet.drive.readText('sheet-1', 100)).resolves.toBe('a,b');
    expect(sheet.text.urls[0]?.searchParams.get('mimeType')).toBe('text/csv');

    const plain = driveFor({ name: 'readme.txt', mimeType: 'text/plain' }, 'hello');
    await expect(plain.drive.readText('txt-1', 100)).resolves.toBe('hello');
    expect(plain.text.urls[0]?.searchParams.get('alt')).toBe('media');
    expect(plain.text.urls[0]?.pathname).toBe('/drive/v3/files/txt-1');
  });

  it('exports Google Slides as plain text', async () => {
    const slides = driveFor({ name: 'slides', mimeType: 'application/vnd.google-apps.presentation' }, 'slide text');

    await expect(slides.drive.readText('slides-1', 100)).resolves.toBe('slide text');
    expect(slides.text.urls[0]?.pathname).toBe('/drive/v3/files/slides-1/export');
    expect(slides.text.urls[0]?.searchParams.get('mimeType')).toBe('text/plain');
  });

  it('refuses unsupported Google types and sensitive names', async () => {
    const form = driveFor({ name: 'form', mimeType: 'application/vnd.google-apps.form' }, 'x');
    await expect(form.drive.readText('form-1', 10)).rejects.toThrow(/no readable text/i);

    const secret = driveFor({ name: '비밀번호.txt', mimeType: 'text/plain' }, 'x');
    await expect(secret.drive.readText('secret-1', 10)).rejects.toThrow(/not allowed/i);
    expect(secret.text.urls).toHaveLength(0);
  });
});

describe('googleDriveConnector', () => {
  it('provides files.drive over the stored Google credentials', async () => {
    const { ctx, secrets } = createTestContext({ config: { folderIds: ['root-1'] } });
    await secrets.set('google.oauth-client', JSON.stringify({ clientId: 'client-id', clientSecret: 'secret' }));
    await secrets.set('google.refresh-token', 'refresh-1');
    const fake = fakeFetch((call) =>
      call.url.hostname === 'oauth2.googleapis.com'
        ? json({ access_token: 'access-1', expires_in: 3600 })
        : json(listHandler(call.url)),
    );
    const plugin = googleDriveConnector({ fetch: fake.fetch, sleep: async () => undefined });

    await plugin.setup(ctx);

    expect(plugin.manifest).toMatchObject({
      id: 'connector.google-drive',
      kind: 'connector',
      title: 'Google Drive',
      secrets: expect.arrayContaining(['google.oauth-client', 'google.refresh-token', 'google.accounts']),
    });
    const listed = await ctx.use(Contracts.filesDrive).list({ limit: 10 });
    expect(listed.map((entry) => entry.name)).toContain('notes');
    expect(fake.calls[0]?.url.hostname).toBe('oauth2.googleapis.com');
    expect(fake.calls[1]?.headers.get('authorization')).toBe('Bearer access-1');
    expect(fake.calls[1]?.url.pathname).toBe('/drive/v3/files');
  });

  it('lists nothing when no folder is configured', async () => {
    const { ctx, secrets } = createTestContext();
    await secrets.set('google.oauth-client', JSON.stringify({ clientId: 'client-id', clientSecret: 'secret' }));
    await secrets.set('google.refresh-token', 'refresh-1');
    const plugin = googleDriveConnector({ fetch: fakeFetch(() => json({})).fetch });

    await plugin.setup(ctx);

    await expect(ctx.use(Contracts.filesDrive).list({ limit: 5 })).resolves.toEqual([]);
  });
});
