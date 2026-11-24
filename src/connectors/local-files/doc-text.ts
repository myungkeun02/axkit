import type { ProcessRunner } from '../../core/process/types.js';

/** Formats macOS `textutil` turns into plain text. PDF and images go through the OCR connector instead. */
export const TEXTUTIL_EXTS = new Set(['doc', 'docx', 'rtf', 'rtfd', 'odt', 'wordml', 'webarchive']);
/** A word file bigger than this is almost always pictures; it is skipped. */
export const MAX_DOCUMENT_BYTES = 30_000_000;

/** `textutil -convert txt -stdout`: built into macOS, reads the file and writes nothing. */
export async function textutilText(run: ProcessRunner, path: string, maxChars: number): Promise<string | undefined> {
  try {
    const result = await run('/usr/bin/textutil', ['-convert', 'txt', '-stdout', '--', path], { timeoutMs: 20_000 });
    if (result.code !== 0 || result.timedOut) return undefined;
    return result.stdout.replace(/\r\n?/g, '\n').slice(0, Math.max(0, maxChars));
  } catch {
    return undefined;
  }
}
