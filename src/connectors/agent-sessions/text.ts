import { maskForModel } from '../../core/text/mask.js';

/** Files larger than this are skipped rather than streamed. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** At most this many sessions per tool, and in total; newest by file time first. */
export const MAX_SESSIONS = 5_000;
const FIRST_PROMPT_CHARS = 200;
const ELLIPSIS = '\n…\n';

export type Role = 'owner' | 'assistant';

export interface Turn {
  role: Role;
  text: string;
}

const WRAPPED_BLOCKS = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<(local-command-[\w-]+|command-[\w-]+)>[\s\S]*?<\/\1>/g,
];
/** Leftover openers whose closer never came: the rest of the text is wrapper too. */
const UNCLOSED_WRAPPER = /<(?:system-reminder|local-command-[\w-]+|command-[\w-]+)>[\s\S]*$/;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The owner's own words: tool wrappers and reminders removed. Empty when nothing of theirs is left. */
export function ownerText(raw: string): string {
  let text = raw;
  for (const block of WRAPPED_BLOCKS) text = text.replace(block, ' ');
  text = collapse(text.replace(UNCLOSED_WRAPPER, ' '));
  return INTERRUPTED.test(text) ? '' : text;
}

export function firstPromptLine(text: string): string {
  const masked = maskForModel(collapse(text));
  return masked.length > FIRST_PROMPT_CHARS ? `${masked.slice(0, FIRST_PROMPT_CHARS - 1)}…` : masked;
}

export function maskedOptional(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const clean = collapse(text);
  return clean.length > 0 ? maskForModel(clean) : undefined;
}

/** "owner: …" / "assistant: …" lines, consecutive turns of one role joined, masked, clipped to maxChars. */
export function renderTranscript(turns: readonly Turn[], maxChars: number): string {
  const merged: Turn[] = [];
  for (const turn of turns) {
    const text = collapse(turn.text);
    if (text.length === 0) continue;
    const last = merged.at(-1);
    if (last !== undefined && last.role === turn.role) last.text = `${last.text} ${text}`;
    else merged.push({ role: turn.role, text });
  }
  const full = maskForModel(merged.map((t) => `${t.role}: ${t.text}`).join('\n'));
  return clip(full, maxChars);
}

/** The first ~40% and the last ~60% when too long. */
export function clip(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) return text;
  if (limit <= ELLIPSIS.length) return text.slice(0, limit);
  const room = limit - ELLIPSIS.length;
  const head = Math.floor(room * 0.4);
  const tail = room - head;
  return `${text.slice(0, head)}${ELLIPSIS}${tail > 0 ? text.slice(-tail) : ''}`;
}

/** "github.com/owner/repo" from any https/ssh/scp-style remote, credentials and ".git" removed. */
export function cleanRemote(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (value.length === 0) return undefined;
  let host: string;
  let path: string;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(value);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      host = url.hostname;
      path = url.pathname;
    } catch {
      return undefined;
    }
  } else if (scp !== null) {
    host = scp[1] ?? '';
    path = scp[2] ?? '';
  } else {
    return undefined;
  }
  const cleanPath = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (host.length === 0) return undefined;
  return maskForModel(cleanPath.length > 0 ? `${host}/${cleanPath}` : host);
}

export function isoFrom(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
  }
  return undefined;
}

export function isoFromEpoch(ms: unknown, seconds: unknown): string | undefined {
  const pick = typeof ms === 'number' || typeof ms === 'bigint' ? Number(ms) : undefined;
  const sec = typeof seconds === 'number' || typeof seconds === 'bigint' ? Number(seconds) * 1000 : undefined;
  const value = pick ?? sec;
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value).toISOString();
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Ids end up in file paths; only plain names are accepted. */
export function safeId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..';
}

export function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export function checkAbort(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError(signal);
}
