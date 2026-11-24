/**
 * Rule-based prompt-injection filter for text from the outside world (mail, web pages, chat screens, OCR, files).
 * Matching lines are replaced whole, so a multi-word payload on the same line goes with them. Detection runs on a
 * normalized copy (HTML entities decoded, invisible characters dropped, whitespace collapsed) and maps back to the
 * original text. Ported from AX `guard/injection.ts`; the optional model second pass is left to callers.
 */

export const REMOVED = '[removed: instruction aimed at the AI]';

export interface InjectionHit {
  start: number;
  end: number;
  kind: string;
  /** 0..1; 0.8 and above is a confirmed attempt worth telling the owner about. */
  score: number;
  quote: string;
}

// Bidi controls, zero-width characters, variation selectors and Unicode tags.
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
/** Typography that is technically invisible but harmless: emoji selectors and ZWJ sequences, soft hyphens, a BOM. */
const BENIGN_INVISIBLE = /[\uFE0E\uFE0F\u00AD]|(?<=\p{Extended_Pictographic}\uFE0F?)\u200D(?=\p{Extended_Pictographic})|^\uFEFF/gu;

const SECRET = String.raw`(?:\b(?:secrets?|tokens?|passwords?|api[_ -]?keys?|credentials?)\b|비밀값|비밀번호|토큰|API\s*키)`;
const SEND = String.raw`(?:\b(?:send|forward|e-?mail|post|upload|paste|leak)\b|보내|전송|유출)`;
const DESTINATION = String.raw`(?:https?:\/\/|[\w.+-]+@[\w-]+\.)`;

const RULES: readonly (readonly [string, number, RegExp])[] = [
  [
    'override',
    0.95,
    /이전\s*지시(?:를)?\s*무시|지시(?:를|는)?\s*(?:모두\s*)?무시하(?:고|라|세요)|ignore\s+(?:(?:all|the|any)\s+)?(?:previous|prior|above)\s+instructions|disregard\s+(?:all\s+)?(?:previous|prior)\s+instructions|you\s+are\s+now\b|AI에게\s*[:：]|중요\s*[:：]\s*AI는|do\s+not\s+tell\s+the\s+(?:user|owner)/i,
  ],
  ['role_spoof', 0.98, /<\s*\/\s*data\s*>|<\s*\/?\s*(?:system|owner_message|task_data)\b|```\s*system\b/i],
  ['role_reference', 0.55, /system\s+prompt|^\s*(?:assistant|system)\s*[:：]/im],
  [
    'exfiltration',
    0.98,
    new RegExp(
      [
        String.raw`^\s*(?:please\s+)?(?:send|forward|e-?mail|post|upload|paste)\s+(?:(?:me|us)\s+)?(?:(?:the|your|all)\s+)?${SECRET}`,
        String.raw`${SECRET}(?:을|를)?\s*(?:전송|보내)(?:해|하라|해라|해\s*줘|주세요|줘)`,
        String.raw`${SEND}.{0,40}${SECRET}.{0,60}${DESTINATION}`,
        String.raw`${SECRET}.{0,60}${DESTINATION}\S*.{0,30}${SEND}`,
      ].join('|'),
      'i',
    ),
  ],
  ['action_spoof', 0.9, /["']tool_calls["']\s*:|["']action["']\s*:\s*["']/i],
  [
    'hidden',
    0.65,
    /display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*(?:0|1|2)(?:px|pt)\b|(?<![-\w])hidden\s*=\s*["']?true|white[- ]on[- ]white|color\s*:\s*(?:white|#fff(?:fff)?)\s*;[^\n]*background(?:-color)?\s*:\s*(?:white|#fff(?:fff)?)/i,
  ],
];

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', zwj: '\u200D', zwnj: '\u200C', shy: '\u00AD',
};

function decodeEntity(token: string): string {
  const numeric = /^&#(x[\da-f]+|\d+);?$/i.exec(token);
  if (numeric !== null) {
    const raw = numeric[1] ?? '';
    const code = raw.startsWith('x') || raw.startsWith('X') ? Number.parseInt(raw.slice(1), 16) : Number(raw);
    return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : token;
  }
  const named = /^&([a-z]+);$/i.exec(token);
  return named !== null ? (NAMED_ENTITIES[(named[1] ?? '').toLowerCase()] ?? token) : token;
}

interface Normalized {
  text: string;
  starts: number[];
  ends: number[];
}

/** Detection-only normalization with UTF-16 offsets back to the unchanged source text. */
function normalize(text: string): Normalized {
  let out = '';
  const starts: number[] = [];
  const ends: number[] = [];
  for (const token of text.matchAll(/&(?:#(?:x[\da-f]+|\d+)|[a-z]+);?|[\s\S]/giu)) {
    const start = token.index;
    const end = start + token[0].length;
    for (const char of decodeEntity(token[0])) {
      if (INVISIBLE.test(char)) continue;
      const value = /\s/u.test(char) ? ' ' : char;
      if (value === ' ' && out.endsWith(' ')) {
        ends[ends.length - 1] = end;
        continue;
      }
      out += value;
      for (let i = 0; i < value.length; i += 1) {
        starts.push(start);
        ends.push(end);
      }
    }
  }
  return { text: out, starts, ends };
}

/** Every suspicious line, widened to whole source lines and merged where they overlap. */
export function injectionHits(text: string): InjectionHit[] {
  if (text === '') return [];
  const hits: InjectionHit[] = [];
  const add = (rawStart: number, rawEnd: number, kind: string, score: number): void => {
    const start = text.lastIndexOf('\n', rawStart - 1) + 1;
    const newline = text.indexOf('\n', rawEnd);
    const end = newline < 0 ? text.length : newline;
    hits.push({ start, end, kind, score, quote: text.slice(start, end) });
  };
  const normalized = normalize(text);
  for (const [kind, score, rule] of RULES) {
    const flags = rule.flags.includes('g') ? rule.flags : `${rule.flags}g`;
    for (const match of normalized.text.matchAll(new RegExp(rule.source, flags))) {
      const first = normalized.starts[match.index];
      const last = normalized.ends[match.index + match[0].length - 1];
      if (first !== undefined && last !== undefined) add(first, last, kind, score);
    }
  }
  // Invisible characters are suspicious on their own, even when dropping them reveals no rule phrase.
  let offset = 0;
  for (const line of text.split('\n')) {
    if (INVISIBLE.test(line.replace(BENIGN_INVISIBLE, ''))) add(offset, offset + line.length, 'invisible', 0.6);
    offset += line.length + 1;
  }
  const merged: InjectionHit[] = [];
  for (const hit of hits.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous !== undefined && hit.start <= previous.end) {
      previous.end = Math.max(previous.end, hit.end);
      if (hit.score > previous.score) {
        previous.score = hit.score;
        previous.kind = hit.kind;
      }
      previous.quote = text.slice(previous.start, previous.end);
    } else {
      merged.push({ ...hit });
    }
  }
  return merged;
}

export interface StripResult {
  text: string;
  hits: InjectionHit[];
}

/**
 * Removes suspicious lines. A line flagged only for invisible characters keeps its visible words and loses just those
 * characters, so ordinary newsletters are not mangled; such hits are not reported either.
 */
export function stripInjections(text: string): StripResult {
  const hits = injectionHits(text);
  if (hits.length === 0) return { text, hits };
  let clean = text;
  for (const hit of [...hits].reverse()) {
    const line = clean.slice(hit.start, hit.end);
    const replacement = hit.kind === 'invisible' ? line.replace(new RegExp(INVISIBLE.source, 'gu'), '') : REMOVED;
    clean = clean.slice(0, hit.start) + replacement + clean.slice(hit.end);
  }
  return { text: clean, hits: hits.filter((hit) => hit.kind !== 'invisible') };
}

/** A short quote safe for logs and owner notices: no URLs, long tokens or control characters. */
export function maskedQuote(text: string): string {
  return text
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-)[\w-]+/gi, '[secret]')
    .replace(/\beyJ[\w-]+\.[\w.-]+/g, '[secret]')
    .replace(/\b[A-Za-z0-9_+/-]{32,}={0,2}/g, '[secret]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[URL]')
    // eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
    .replace(/[\u0000-\u001f\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, ' ')
    .slice(0, 200);
}
