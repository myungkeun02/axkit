import { describe, expect, it } from 'vitest';
import type { FileEntry, FileSource } from '../../../src/core/contracts/files.js';
import { driveView } from '../../../src/skills/files/drive-view.js';

const file = (id: string, name: string, modifiedAt: string): FileEntry => ({ id, name, path: `Drive/${name}`, mimeType: 'application/vnd.google-apps.document', size: 0, modifiedAt });

function source(label: string, title?: string): FileSource {
  return {
    label,
    ...(title !== undefined ? { title } : {}),
    list: async () => [],
    readText: async () => '',
    recent: async () => [file('r1', '주간 보고', '2026-11-24T01:00:00Z')],
    children: async (folder?: string) =>
      folder === 'root'
        ? { folders: [{ id: 'f1', name: '기획' }], files: [file('d1', '회사소개서', '2026-11-20T01:00:00Z')] }
        : folder === 'f1'
          ? { folders: [], files: [file('d2', '영상 기획안', '2026-11-23T01:00:00Z')] }
          : { folders: [], files: [] },
  };
}

const clock = { now: () => new Date('2026-11-25T03:00:00Z') } as never;
const read = (view: ReturnType<typeof driveView>, query: Record<string, string> = {}) => view.read(new URLSearchParams(query)) as Promise<{ blocks: { kind: string; title?: string; text?: string; rows?: { title: string; query?: Record<string, string>; message?: string }[] }[] }>;

describe('drive as a folder tree', () => {
  it('offers the tree from the recent list, then walks folders with the path as breadcrumb', async () => {
    const view = driveView({ sources: () => [source('drive')], clock, timeZone: 'Asia/Seoul' });
    const recent = await read(view);
    expect(recent.blocks[0]?.rows?.[0]).toMatchObject({ title: '📁 폴더로 보기', query: { mode: 'tree' } });
    const top = await read(view, { mode: 'tree' });
    expect(top.blocks.flatMap((b) => b.rows ?? []).map((r) => r.title)).toEqual(['내 드라이브', '공유 문서함', '← 최근 바뀐 파일로']);
    const root = await read(view, { mode: 'tree', source: 'drive', folder: 'root', path: '내 드라이브' });
    expect(root.blocks[0]?.text).toBe('📁 내 드라이브');
    const folderRow = root.blocks.find((b) => b.title === '폴더 · 1개')?.rows?.[0];
    expect(folderRow).toEqual({ title: '📁 기획', query: { mode: 'tree', source: 'drive', folder: 'f1', path: '내 드라이브 / 기획' } });
    expect(root.blocks.find((b) => b.title === '파일 · 1개')?.rows?.[0]).toMatchObject({ title: '회사소개서', message: expect.stringContaining('회사소개서') });
    const inner = await read(view, folderRow?.query);
    expect(inner.blocks[0]?.text).toBe('📁 내 드라이브 › 기획');
    expect(inner.blocks.find((b) => b.title === '파일 · 1개')?.rows?.[0]?.title).toBe('영상 기획안');
  });

  it('starts from the accounts when several are connected', async () => {
    const view = driveView({ sources: () => [source('drive', 'Google Drive · a@example.com'), source('drive:a2', 'Google Drive · b@example.com')], clock, timeZone: 'Asia/Seoul' });
    const top = await read(view, { mode: 'tree' });
    expect(top.blocks[0]?.rows?.map((r) => r.title)).toEqual(['a@example.com', 'b@example.com']);
  });
});
