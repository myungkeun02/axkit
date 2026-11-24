/**
 * Terminal look for `ax-kit setup`: one small palette, display widths that count Korean as two columns, and the step
 * header and summary blocks. Everything returns plain strings; colour is opt-in so tests and pipes stay plain.
 */

export interface Paint {
  accent(text: string): string;
  ok(text: string): string;
  warn(text: string): string;
  error(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}

const wrap = (open: string, close: string) => (text: string): string => `\u001b[${open}m${text}\u001b[${close}m`;

export const COLOR: Paint = {
  accent: wrap('36', '39'),
  ok: wrap('32', '39'),
  warn: wrap('33', '39'),
  error: wrap('31', '39'),
  dim: wrap('2', '22'),
  bold: wrap('1', '22'),
};

const same = (text: string): string => text;
export const PLAIN: Paint = { accent: same, ok: same, warn: same, error: same, dim: same, bold: same };

/** Colour only on a real terminal, and never when NO_COLOR is set (https://no-color.org). */
export function paintFor(isTty: boolean, env: Readonly<Record<string, string | undefined>> = process.env): Paint {
  return isTty && env['NO_COLOR'] === undefined && env['TERM'] !== 'dumb' ? COLOR : PLAIN;
}

/** Hangul, CJK, full-width forms and most emoji take two terminal columns. */
function charWidth(code: number): number {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code >= 0x300 && code <= 0x36f) return 0;
  if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2;
  }
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/** Cuts `text` to at most `max` columns, ending with … when something was cut. */
export function truncate(text: string, max: number): string {
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (width + w > max - 1) break;
    out += ch;
    width += w;
  }
  return `${out}…`;
}

/** Breaks `text` into lines of at most `max` columns, preferring spaces. */
export function wrapText(text: string, max: number): string[] {
  if (max <= 1) return [text];
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (displayWidth(candidate) <= max) {
      line = candidate;
      continue;
    }
    if (line !== '') lines.push(line);
    line = word;
    while (displayWidth(line) > max) {
      let head = '';
      for (const ch of line) {
        if (displayWidth(head + ch) > max) break;
        head += ch;
      }
      lines.push(head);
      line = line.slice(head.length);
    }
  }
  if (line !== '' || lines.length === 0) lines.push(line);
  return lines;
}

export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(1, width - displayWidth(text)));
}

/** "━━━━──── 3/7 · AI 연결" plus an optional one-line explanation. */
export function formatStep(index: number, total: number, title: string, note: string | undefined, width: number, paint: Paint): string[] {
  const safeTotal = Math.max(1, total);
  const done = Math.min(safeTotal, Math.max(0, index));
  const barWidth = Math.max(4, Math.min(14, width - displayWidth(title) - 12));
  const filled = Math.round((done / safeTotal) * barWidth);
  const bar = `${paint.accent('━'.repeat(filled))}${paint.dim('─'.repeat(barWidth - filled))}`;
  const head = truncate(`${done}/${safeTotal} · ${title}`, Math.max(8, width - barWidth - 2));
  const lines = ['', `${bar} ${paint.bold(head)}`];
  if (note !== undefined && note !== '') for (const line of wrapText(note, Math.max(10, width - 2))) lines.push(paint.dim(line));
  return lines;
}

export interface SummaryRow {
  label: string;
  value: string;
  /** true = 켜짐 (✔), false = 꺼짐/나중에 (○); leave out for plain information. */
  on?: boolean;
}

/** The end screen: "이렇게 설정했어요", one row per setting, then what to do next. */
export function formatSummary(title: string, rows: readonly SummaryRow[], next: readonly string[], width: number, paint: Paint): string[] {
  const labelWidth = Math.min(16, Math.max(...rows.map((row) => displayWidth(row.label)), 4) + 2);
  const lines = ['', paint.bold(paint.accent(`■ ${title}`))];
  for (const row of rows) {
    const mark = row.on === undefined ? paint.dim('·') : row.on ? paint.ok('✔') : paint.dim('○');
    const value = truncate(row.value, Math.max(8, width - labelWidth - 5));
    lines.push(`  ${mark} ${padEnd(row.label, labelWidth)}${row.on === false ? paint.dim(value) : value}`);
  }
  if (next.length > 0) {
    lines.push('', paint.bold('다음에 할 일'));
    for (const line of next) lines.push(`  ${line}`);
  }
  return lines;
}
