import type { AppView } from '../../core/contracts/device-api.js';
import type { FileEntry, FileSource } from '../../core/contracts/files.js';
import type { Clock } from '../../core/scheduler/types.js';
import { clockTime, dayOf, folderOf } from './change-view.js';
import { treeBlocks } from './drive-tree.js';

const DAY_MS = 86_400_000;
const VIEW_DAYS = 30;
const MAX_ROWS = 40;
/** Opening the screen again within this asks Drive nothing. */
const CACHE_MS = 5 * 60_000;

export const isDriveSource = (source: FileSource): boolean => source.label === 'drive' || source.label.startsWith('drive:');

interface Found {
  entry: FileEntry;
  account: string;
}

/**
 * App view "drive": the owner's own Drive files changed in the last 30 days, from every connected Google account,
 * newest first and grouped by day. Each row carries the chat message that asks about the file (`message`), for apps
 * that make rows tappable; the ask blocks work everywhere.
 */
export function driveView(deps: { sources: () => readonly FileSource[]; clock: Clock; timeZone: string }): AppView {
  let cached: { at: number; value: { title: string; blocks: Record<string, unknown>[] } } | undefined;
  return {
    name: 'drive',
    version: 1,
    ui: 'blocks',
    title: '드라이브',
    icon: 'externaldrive',
    async read(query) {
      const now = deps.clock.now();
      const params = Object.fromEntries(query ?? new URLSearchParams()) as Record<string, string>;
      // the folder tree, one folder at a time (rows carry the next `query`)
      if (params.mode === 'tree') {
        const tree = await treeBlocks(deps.sources().filter(isDriveSource), { ...(params.source !== undefined ? { source: params.source } : {}), ...(params.folder !== undefined ? { folder: params.folder } : {}), ...(params.path !== undefined ? { path: params.path } : {}) }, deps.timeZone).catch(() => [{ kind: 'text', text: '드라이브 폴더를 지금 읽지 못했어요. 잠시 뒤 다시 열어 주세요.' }]);
        return { title: '드라이브', blocks: tree };
      }
      if (cached !== undefined && now.getTime() - cached.at < CACHE_MS) return cached.value;
      const sources = deps.sources().filter(isDriveSource);
      const multi = sources.length > 1;
      const failed: string[] = [];
      const found: Found[] = [];
      await Promise.all(
        sources.map(async (source) => {
          const account = source.title?.replace(/^Google Drive · /, '') ?? '기본 계정';
          try {
            const entries = source.recent !== undefined ? await source.recent({ modifiedAfter: new Date(now.getTime() - VIEW_DAYS * DAY_MS), limit: MAX_ROWS }) : await source.list({ limit: MAX_ROWS });
            for (const entry of entries) found.push({ entry, account });
          } catch {
            failed.push(account);
          }
        }),
      );
      found.sort((a, b) => Date.parse(b.entry.modifiedAt) - Date.parse(a.entry.modifiedAt));
      const shown = found.slice(0, MAX_ROWS);
      const blocks: Record<string, unknown>[] = [];
      if (sources.length === 0) {
        blocks.push({ kind: 'text', text: '구글 드라이브가 연결돼 있지 않아요.' }, { kind: 'note', text: '맥에서 `ax-kit connect google`로 연결하고 드라이브를 켜 주세요.' });
        return { title: '드라이브', blocks };
      }
      blocks.push({ kind: 'list', rows: [{ title: '📁 폴더로 보기', detail: '내 드라이브·공유 문서함을 폴더별로', query: { mode: 'tree' } }] });
      blocks.push({ kind: 'stat', title: `최근 ${VIEW_DAYS}일 동안 바뀐 내 파일`, value: `${found.length >= MAX_ROWS ? `${MAX_ROWS}건 넘게` : `${found.length}건`}` });
      const days = new Map<string, { label: string; items: Found[] }>();
      for (const item of shown) {
        const day = dayOf(item.entry.modifiedAt, now, deps.timeZone);
        const group = days.get(day.key) ?? { label: day.label, items: [] };
        group.items.push(item);
        days.set(day.key, group);
      }
      for (const group of days.values()) {
        blocks.push({
          kind: 'list',
          title: `${group.label} · ${group.items.length}건`,
          rows: group.items.map(({ entry, account }) => ({
            title: entry.name,
            detail: [folderOf(entry.path), ...(multi ? [account] : [])].join(' · '),
            trailing: clockTime(entry.modifiedAt, deps.timeZone),
            message: `드라이브의 "${entry.name}" 파일로 할 일을 골라 줘: 요약하기, 또는 내 지식 문서에 반영하기`,
          })),
        });
      }
      if (found.length === 0) blocks.push({ kind: 'text', text: `최근 ${VIEW_DAYS}일 동안 바뀐 내 드라이브 파일이 없어요.` });
      for (const account of failed) blocks.push({ kind: 'note', text: `${account}의 드라이브를 지금 읽지 못했어요. 잠시 뒤 다시 열어 주세요.` });
      blocks.push({ kind: 'note', text: '내가 만든 파일만 보여요(공유받은 파일은 빠져요). 파일을 누르면 요약하거나, 그 내용으로 내 지식 문서(프로필·프로젝트)를 고칠 수 있어요. 고치기 전에는 바뀌는 줄을 보여 주고 물어봐요.' });
      blocks.push({ kind: 'ask', title: '최근 문서 요약 부탁하기', message: '드라이브에서 최근에 바뀐 문서들 요약해 줘' });
      blocks.push({ kind: 'ask', title: '드라이브에서 파일 찾기', message: '드라이브에서 파일 찾아 줘' });
      blocks.push({ kind: 'ask', title: '파일로 내 지식 문서 고치기', message: '드라이브 파일 하나로 내 지식 문서를 고치고 싶어. 어떤 파일로 할지 물어봐 줘' });
      const value = { title: '드라이브', blocks };
      // a failed account is asked again on the next open
      if (failed.length === 0) cached = { at: now.getTime(), value };
      return value;
    },
  };
}
