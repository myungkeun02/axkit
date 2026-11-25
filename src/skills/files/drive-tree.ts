import type { FileSource } from '../../core/contracts/files.js';
import { clockTime } from './change-view.js';

const MAX_FOLDERS = 60;
const MAX_FILES = 80;

/** A source's id in the screen's query: its label ("drive", "drive:a2"). */
export const sourceKey = (source: FileSource): string => source.label;
const accountOf = (source: FileSource): string => source.title?.replace(/^Google Drive · /, '') ?? '기본 계정';

function kindOf(mime: string | undefined, name: string): string {
  if (mime === 'application/vnd.google-apps.document') return '문서';
  if (mime === 'application/vnd.google-apps.spreadsheet') return '시트';
  const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toUpperCase();
  return ext ?? '파일';
}

/**
 * The folder tree, like a file manager: the accounts (when several), then "내 드라이브" and "공유 문서함", then each
 * folder's subfolders and files. Folder rows carry `query`: tapping one reloads this screen with it. `path` is the
 * breadcrumb the app passes along (names joined with " / "), so nothing has to be looked up again.
 */
export async function treeBlocks(sources: readonly FileSource[], query: { source?: string; folder?: string; path?: string }, timeZone: string): Promise<Record<string, unknown>[]> {
  const browsable = sources.filter((source) => source.children !== undefined);
  const blocks: Record<string, unknown>[] = [];
  const back = { kind: 'list', rows: [{ title: '← 최근 바뀐 파일로', query: {} }] };
  if (query.source === undefined && browsable.length > 1) {
    blocks.push({ kind: 'list', title: '계정', rows: browsable.map((source) => ({ title: accountOf(source), detail: '드라이브', query: { mode: 'tree', source: sourceKey(source) } })) }, back);
    return blocks;
  }
  const source = browsable.find((item) => sourceKey(item) === query.source) ?? browsable[0];
  if (source?.children === undefined) return [{ kind: 'text', text: '폴더로 볼 수 있는 드라이브가 없어요.' }, back];
  const key = sourceKey(source);
  if (query.folder === undefined) {
    blocks.push(
      { kind: 'text', text: browsable.length > 1 ? accountOf(source) : '드라이브' },
      { kind: 'list', title: '어디를 볼까요?', rows: [{ title: '내 드라이브', query: { mode: 'tree', source: key, folder: 'root', path: '내 드라이브' } }, { title: '공유 문서함', detail: '다른 사람이 공유한 파일', query: { mode: 'tree', source: key, folder: 'shared', path: '공유 문서함' } }] },
      back,
    );
    return blocks;
  }
  const path = (query.path ?? '').slice(0, 300);
  const { folders, files } = await source.children(query.folder);
  const crumbs = path.split(' / ').filter((part) => part !== '');
  blocks.push({ kind: 'text', text: `📁 ${crumbs.join(' › ') || '폴더'}` });
  // up one level: the parent is not known by id here, so "up" goes back to the account's top
  blocks.push({ kind: 'list', rows: [{ title: '↑ 처음 위치로', query: { mode: 'tree', source: key } }] });
  if (folders.length > 0) {
    blocks.push({
      kind: 'list',
      title: `폴더 · ${String(folders.length)}개`,
      rows: folders.slice(0, MAX_FOLDERS).map((folder) => ({ title: `📁 ${folder.name}`, query: { mode: 'tree', source: key, folder: folder.id, path: [...crumbs, folder.name].join(' / ') } })),
    });
  }
  if (files.length > 0) {
    blocks.push({
      kind: 'list',
      title: `파일 · ${String(files.length)}개`,
      rows: files
        .sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))
        .slice(0, MAX_FILES)
        .map((file) => ({
          title: file.name,
          detail: `${kindOf(file.mimeType, file.name)} · ${file.modifiedAt.slice(0, 10)}`,
          trailing: clockTime(file.modifiedAt, timeZone),
          message: `드라이브의 "${file.name}" 파일로 할 일을 골라 줘: 요약하기, 또는 내 지식 문서에 반영하기`,
        })),
    });
  }
  if (folders.length === 0 && files.length === 0) blocks.push({ kind: 'text', text: '이 폴더는 비어 있어요.' });
  return blocks;
}
