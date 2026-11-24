import type { AxNode, AxSnapshot } from '../ax-tree.js';
import { nodeText } from '../ax-tree.js';

export interface KakaoRow {
  title: string;
  preview: string;
  unread: number | null;
}

const LIST_ROLES = new Set(['AXTable', 'AXOutline', 'AXList']);
const TEXT_ROLES = new Set(['AXStaticText', 'AXTextField', 'AXButton']);
const SELF_ROOMS = new Set(['나와의 채팅', 'Chat with myself', '나']);
const COUNT = /^\d[\d,]*\+?$/;

const TIME_PATTERNS: readonly RegExp[] = [
  /^(?:오전|오후)\s*\d{1,2}:\d{2}$/,
  /^\d{1,2}:\d{2}$/,
  /^어제$/,
  /^그저께$/,
  /^\d{1,2}월\s*\d{1,2}일$/,
  /^\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?$/,
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{1,2}:\d{2}\s*(?:AM|PM)$/i,
  /^Yesterday$/i,
  /^(?:월|화|수|목|금|토|일)요일$/,
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i,
];

interface Badge {
  present: boolean;
  unread: number | null;
}

interface ScannedRow {
  title: string;
  preview: string;
  badge: Badge;
}

function isTime(text: string): boolean {
  return TIME_PATTERNS.some((pattern) => pattern.test(text));
}

function isCount(text: string): boolean {
  return COUNT.test(text);
}

function indicesBelow(nodes: readonly AxNode[], index: number): number[] {
  const node = nodes[index];
  if (node === undefined) return [];
  const result: number[] = [];
  for (let cursor = index + 1; cursor < nodes.length; cursor += 1) {
    const next = nodes[cursor];
    if (next === undefined || next.depth <= node.depth) break;
    result.push(cursor);
  }
  return result;
}

function listIndexOf(nodes: readonly AxNode[], window: number): number | undefined {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node !== undefined && node.window === window && LIST_ROLES.has(node.role)) return index;
  }
  return undefined;
}

function rowIndices(nodes: readonly AxNode[], listIndex: number): number[] {
  const list = nodes[listIndex];
  if (list === undefined) return [];
  const below = indicesBelow(nodes, listIndex);
  const rows = below.filter((index) => nodes[index]?.role === 'AXRow');
  if (rows.length > 0) return rows;
  if (list.role !== 'AXList') return [];
  return below.filter((index) => nodes[index]?.depth === list.depth + 1);
}

function badgeOf(nodes: readonly AxNode[], rowIndex: number): Badge {
  const row = nodes[rowIndex];
  if (row === undefined) return { present: false, unread: null };
  const candidates: AxNode[] = [row];
  for (const index of indicesBelow(nodes, rowIndex)) {
    const node = nodes[index];
    if (node !== undefined) candidates.push(node);
  }
  const badge = candidates.find((node) => node.identifier === 'Count Label');
  if (badge === undefined) return { present: false, unread: null };
  const raw = nodeText(badge).replaceAll(',', '').replace(/\+$/, '').trim();
  if (!/^\d+$/.test(raw)) return { present: true, unread: null };
  const value = Number(raw);
  return { present: true, unread: Number.isFinite(value) ? value : null };
}

function textsOf(nodes: readonly AxNode[], rowIndex: number): string[] {
  const texts: string[] = [];
  for (const index of indicesBelow(nodes, rowIndex)) {
    const node = nodes[index];
    if (node === undefined || !TEXT_ROLES.has(node.role)) continue;
    const text = nodeText(node).trim();
    if (text !== '') texts.push(text);
  }
  return texts;
}

function titleAndPreview(texts: readonly string[]): { title: string; preview: string } {
  const meaningful = texts.filter((text) => !isTime(text) && !isCount(text));
  const title = meaningful[0] ?? '';
  const preview = meaningful.slice(1).find((text) => text !== title) ?? '';
  return { title, preview };
}

function scanWindow(nodes: readonly AxNode[], window: number): ScannedRow[] {
  const listIndex = listIndexOf(nodes, window);
  if (listIndex === undefined) return [];
  return rowIndices(nodes, listIndex).map((rowIndex) => ({
    ...titleAndPreview(textsOf(nodes, rowIndex)),
    badge: badgeOf(nodes, rowIndex),
  }));
}

/** Latest message line per room in the first window that shows a chat list. */
export function parseKakaoList(snapshot: AxSnapshot, limit: number): KakaoRow[] {
  if (!snapshot.running) return [];
  for (let window = 0; window < snapshot.windows.length; window += 1) {
    const rows = scanWindow(snapshot.nodes, window).filter(
      (row) => row.title !== '' && !SELF_ROOMS.has(row.title),
    );
    if (rows.length === 0) continue;
    const anyBadge = rows.some((row) => row.badge.present);
    return rows.slice(0, Math.max(0, limit)).map((row) => ({
      title: row.title,
      preview: row.preview,
      unread: anyBadge ? (row.badge.present ? row.badge.unread : 0) : null,
    }));
  }
  return [];
}
