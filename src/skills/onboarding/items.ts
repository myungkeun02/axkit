import type { FileEntry } from '../../core/contracts/files.js';
import type { FolderWalk } from '../../core/contracts/scan.js';
import { extensionOf } from '../../core/files/filter.js';

export type ScanItemSource = 'local' | 'drive' | 'project';
export type ScanItemKind = 'file' | 'repo' | 'drive' | 'doc' | 'session';

export interface ScanItem {
  source: ScanItemSource;
  kind: ScanItemKind;
  id: string;
  path: string;
  title: string;
  /** ISO 8601. */
  modifiedAt: string;
  size: number;
  readable: boolean;
  /** The picked project (its path) a document or session belongs to. */
  project?: string;
  /** A PDF or word-processor file: read through a converter, not as plain text. */
  rich?: boolean;
}

/** PDF (on-device text layer / OCR) and word-processor formats macOS converts; résumés and plans mostly live here. */
export const RICH_EXTS = new Set(['pdf', 'doc', 'docx', 'rtf', 'rtfd', 'odt', 'wordml']);
const MAX_RICH_BYTES = 30_000_000;

export const ACTIVE_FOLDERS_LABEL = '최근 90일 활동 폴더';
const MAX_LOCAL_FILES = 400;
/** The deep first look reads every document in the chosen folders; this only stops a runaway walk. */
export const DEEP_LOCAL_FILES = 100_000;
const RECENT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

const GOOGLE_TEXT_MIME = new Set([
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
]);

const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'html',
  'htm',
  'org',
  'rst',
  'log',
  'yaml',
  'yml',
  'xml',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'sh',
  'sql',
]);

const DOC_EXTS = new Set(['md', 'txt', 'doc', 'docx', 'pdf', 'hwp', 'pages', 'key', 'ppt', 'pptx', 'xls', 'xlsx', 'csv']);
const CODE_EXTS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'swift',
  'kt',
  'java',
  'go',
  'rs',
  'rb',
  'c',
  'h',
  'cc',
  'cpp',
  'cs',
  'php',
  'sh',
  'sql',
  'json',
  'yaml',
  'yml',
  'xml',
]);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'heic', 'webp', 'svg', 'tiff', 'tif', 'raw']);

function byNewest(left: { modifiedAt: string; path: string }, right: { modifiedAt: string; path: string }): number {
  return right.modifiedAt.localeCompare(left.modifiedAt) || left.path.localeCompare(right.path);
}

/** Repositories first, then readable files newest first. Refs are preferred in summaries. */
export function itemsFromWalk(walk: FolderWalk, maxFiles = MAX_LOCAL_FILES): ScanItem[] {
  const repos: ScanItem[] = [...walk.repos]
    .sort(byNewest)
    .map((repo) => ({
      source: 'local',
      kind: 'repo',
      id: repo.id,
      path: repo.path,
      title: repo.name,
      modifiedAt: repo.modifiedAt,
      size: 0,
      readable: true,
    }));

  const rich = (file: FolderWalk['files'][number]): boolean => !file.readable && RICH_EXTS.has(file.ext) && file.size <= MAX_RICH_BYTES;
  // Spreadsheets, slides and other documents with no converter still count by name: recurring reports show there.
  const files: ScanItem[] = walk.files
    .filter((file) => file.readable || rich(file) || DOC_EXTS.has(file.ext))
    .sort(byNewest)
    .slice(0, maxFiles)
    .map((file) => ({
      source: 'local',
      kind: 'file',
      id: file.id,
      path: file.path,
      title: file.name,
      modifiedAt: file.modifiedAt,
      size: file.size,
      readable: file.readable || rich(file),
      ...(rich(file) ? { rich: true } : {}),
    }));

  return [...repos, ...files];
}

function driveReadable(entry: FileEntry): boolean {
  if (entry.mimeType !== undefined && GOOGLE_TEXT_MIME.has(entry.mimeType)) return true;
  return TEXT_EXTS.has(extensionOf(entry.name));
}

/** Recently changed Drive files. Google Docs/Sheets/Slides and plain text types can be read. */
export function itemsFromDrive(entries: readonly FileEntry[]): ScanItem[] {
  return entries
    .map((entry) => ({
      source: 'drive' as const,
      kind: 'drive' as const,
      id: entry.id,
      path: entry.path,
      title: entry.name,
      modifiedAt: entry.modifiedAt,
      size: entry.size,
      readable: driveReadable(entry),
    }))
    .sort(byNewest);
}

function groupOf(ext: string): 'docs' | 'code' | 'images' | 'other' {
  if (DOC_EXTS.has(ext)) return 'docs';
  if (CODE_EXTS.has(ext)) return 'code';
  if (IMAGE_EXTS.has(ext)) return 'images';
  return 'other';
}

/** First two path segments below the root marker, for grouping activity. */
function folderOf(path: string): string | undefined {
  const parts = path.split('/').filter((part) => part !== '' && part !== '.' && part !== '..');
  if (parts[0] === '~') parts.shift();
  const dirs = parts.slice(0, -1);
  return dirs.length === 0 ? undefined : dirs.slice(0, 2).join('/');
}

/** Code-only folder statistics: kind counts and the sub-folders touched most in the last 90 days. */
export function folderStats(walk: FolderWalk, now: Date): string[] {
  const counts = { docs: 0, code: 0, images: 0, other: 0 };
  for (const file of walk.files) counts[groupOf(file.ext)] += 1;

  const lines = [
    `문서 ${counts.docs}개 · 코드 ${counts.code}개 · 이미지 ${counts.images}개 · 기타 ${counts.other}개`,
  ];

  const cutoff = now.getTime() - RECENT_DAYS * DAY_MS;
  const active = new Map<string, number>();
  for (const file of walk.files) {
    const modified = Date.parse(file.modifiedAt);
    if (!Number.isFinite(modified) || modified < cutoff) continue;
    const folder = folderOf(file.path);
    if (folder === undefined) continue;
    active.set(folder, (active.get(folder) ?? 0) + 1);
  }

  const top = [...active.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5);
  if (top.length > 0) {
    lines.push(`${ACTIVE_FOLDERS_LABEL}: ${top.map(([folder, count]) => `${folder} (${count})`).join(', ')}`);
  }
  return lines;
}
