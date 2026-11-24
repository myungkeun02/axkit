import { createHash } from 'node:crypto';

const DATE_ONLY = /^[\d\s./:-]+$/;
const TIMESTAMP = /^\d{4}-\d{1,2}-\d{1,2}[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/i;
const TIME = /^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?$/i;
const EN_DATE =
  /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}(?:\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?$/i;
const KO_FULL_DATE = /^\d{4}년\s*\d{1,2}월\s*\d{1,2}일(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?$/;
const KO_SHORT_DATE = /^\d{1,2}월\s*\d{1,2}일(?:\s*\([^)]*\))?$/;
const KO_AMPM_TIME = /^(?:오전|오후)\s*\d{1,2}:\d{2}$/;

function isStamp(line: string): boolean {
  return (
    DATE_ONLY.test(line) ||
    TIMESTAMP.test(line) ||
    TIME.test(line) ||
    EN_DATE.test(line) ||
    KO_FULL_DATE.test(line) ||
    KO_SHORT_DATE.test(line) ||
    KO_AMPM_TIME.test(line)
  );
}

/** Lines worth diffing: trimmed, single-spaced, no blanks, no date or time stamps. */
export function normalizedLines(text: string): string[] {
  const lines: string[] = [];
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (line === '') continue;
    if (isStamp(line)) continue;
    lines.push(line);
  }
  return lines;
}

export function hashLines(lines: readonly string[]): string {
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

export function addedLines(previous: readonly string[], current: readonly string[]): string[] {
  const known = new Set(previous);
  const seen = new Set<string>();
  const added: string[] = [];
  for (const line of current) {
    if (known.has(line) || seen.has(line)) continue;
    seen.add(line);
    added.push(line);
  }
  return added;
}
