import { z } from 'zod';
import type { AppView } from '../../core/contracts/device-api.js';
import type { FileChangeKind, FileChangeRecord } from '../../core/contracts/files.js';
import type { Clock } from '../../core/scheduler/types.js';
import { wallClock } from '../../core/scheduler/next-run.js';
import type { Tool } from '../../core/tools/types.js';
import type { ChangeLog } from './changes.js';
import { localStamp } from './tools.js';

const HOUR_MS = 3_600_000;
const VIEW_DAYS = 7;
const ROWS_PER_DAY = 30;
const TOOL_MAX = 100;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const KIND_KO: Readonly<Record<FileChangeKind, string>> = { added: '새로 생김', changed: '바뀜', removed: '지워짐' };

const changesInput = z.object({
  since_hours: z.number().int().min(1).max(24 * 30).default(24).describe('How far back to look, in hours (48 covers "yesterday").'),
  folder: z.string().trim().min(1).max(300).optional().describe('Only changes inside this folder, e.g. "~/Documents" or "notes".'),
});

export type FilesChangesInput = z.infer<typeof changesInput>;

export interface FilesChangesResult {
  changes: (FileChangeRecord & { name: string })[];
  total: number;
  /** False when folders are only checked hourly, so the newest changes may be missing. */
  watching: boolean;
}

export function nameOf(path: string): string {
  return path.split('/').filter((part) => part !== '').at(-1) ?? path;
}

export function folderOf(path: string): string {
  const parts = path.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : path;
}

/** Tool "files.changes": what changed in the watched folders lately. Read-only. */
export function filesChangesTool(deps: {
  changes: ChangeLog;
  clock: Clock;
  timeZone: string;
  watching: () => boolean;
}): Tool<FilesChangesInput, FilesChangesResult> {
  return {
    name: 'files.changes',
    description:
      'List files that were added, changed or removed in the owner\'s connected folders recently (newest first). Paths are home-relative; use for "what changed yesterday?".',
    input: changesInput,
    effects: ['read'],
    async run(input) {
      const from = new Date(deps.clock.now().getTime() - input.since_hours * HOUR_MS);
      const found = await deps.changes.since(from, input.folder);
      return {
        changes: found.slice(0, TOOL_MAX).map((record) => ({ ...record, name: nameOf(record.path), at: localStamp(record.at, deps.timeZone) })),
        total: found.length,
        watching: deps.watching(),
      };
    },
  };
}

interface DayKey {
  key: string;
  label: string;
}

export function dayOf(iso: string, now: Date, timeZone: string): DayKey {
  const wall = wallClock(new Date(iso), timeZone);
  const today = wallClock(now, timeZone);
  const key = `${wall.y}-${wall.m}-${wall.d}`;
  const diff = Math.round((Date.UTC(today.y, today.m - 1, today.d) - Date.UTC(wall.y, wall.m - 1, wall.d)) / 86_400_000);
  if (diff === 0) return { key, label: '오늘' };
  if (diff === 1) return { key, label: '어제' };
  const weekday = WEEKDAYS[new Date(Date.UTC(wall.y, wall.m - 1, wall.d)).getUTCDay()] ?? '';
  return { key, label: `${wall.m}월 ${wall.d}일 (${weekday})` };
}

export function clockTime(iso: string, timeZone: string): string {
  const wall = wallClock(new Date(iso), timeZone);
  return `${String(wall.hh).padStart(2, '0')}:${String(wall.mm).padStart(2, '0')}`;
}

/** App view "file-changes": the last week of file changes, grouped by day, in plain Korean. */
export function fileChangesView(deps: { changes: ChangeLog; clock: Clock; timeZone: string; watching: () => boolean }): AppView {
  return {
    name: 'file-changes',
    version: 1,
    ui: 'blocks',
    title: '파일 변경',
    icon: 'doc.badge.clock',
    async read() {
      const now = deps.clock.now();
      const records = await deps.changes.since(new Date(now.getTime() - VIEW_DAYS * 24 * HOUR_MS));
      const blocks: Record<string, unknown>[] = [{ kind: 'stat', title: '최근 7일 동안 바뀐 파일', value: `${records.length}건` }];
      const days = new Map<string, { label: string; records: FileChangeRecord[] }>();
      for (const record of records) {
        const day = dayOf(record.at, now, deps.timeZone);
        const group = days.get(day.key) ?? { label: day.label, records: [] };
        group.records.push(record);
        days.set(day.key, group);
      }
      for (const group of days.values()) {
        blocks.push({
          kind: 'list',
          title: `${group.label} · ${group.records.length}건`,
          rows: group.records.slice(0, ROWS_PER_DAY).map((record) => ({
            title: nameOf(record.path),
            detail: `${KIND_KO[record.kind]} · ${folderOf(record.path)}`,
            trailing: clockTime(record.at, deps.timeZone),
          })),
        });
      }
      if (records.length === 0) blocks.push({ kind: 'text', text: '최근 일주일 동안 바뀐 파일이 없어요.' });
      if (!deps.watching()) blocks.push({ kind: 'note', text: '지금은 폴더를 실시간으로 보지 못해서 한 시간마다 확인해요.' });
      blocks.push({ kind: 'note', text: '맥에서 연결한 폴더만 봐요. 숨김 파일과 비밀번호·키처럼 보이는 파일은 빼요.' });
      blocks.push({ kind: 'ask', title: '어제 바뀐 파일 물어보기', message: '어제 뭐 바뀌었어?' });
      return { title: '파일 변경', blocks };
    },
  };
}
