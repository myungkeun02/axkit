import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TextRecognizer } from '../contracts/ocr.js';
import type { ProcessRunner } from '../process/types.js';

const WORD = /\.(docx?|rtf|odt)$/i;
const PDF = /\.pdf$/i;
const PLAIN = /\.(txt|md|csv)$/i;

/** File names whose text this Mac can read without uploading anything. */
export function readableAttachment(name: string): boolean {
  return PDF.test(name) || WORD.test(name) || PLAIN.test(name);
}

/**
 * Text of a downloaded attachment: plain text as is, PDF through the on-device reader (when connected), Word files
 * through macOS textutil. The bytes go to a private temporary folder that is removed right after.
 */
export async function attachmentText(name: string, data: Uint8Array, maxChars: number, deps: { ocr?: TextRecognizer; run: ProcessRunner }): Promise<string | undefined> {
  if (PLAIN.test(name)) return Buffer.from(data).toString('utf8').slice(0, maxChars);
  if (!PDF.test(name) && !WORD.test(name)) return undefined;
  if (PDF.test(name) && deps.ocr === undefined) return undefined;
  const dir = await mkdtemp(join(tmpdir(), 'ax-kit-attach-'));
  const path = join(dir, PDF.test(name) ? 'file.pdf' : `file${name.slice(name.lastIndexOf('.'))}`);
  try {
    await writeFile(path, data, { mode: 0o600 });
    if (PDF.test(name)) return (await deps.ocr?.recognize(path, { maxPages: 6 }))?.text.slice(0, maxChars);
    const result = await deps.run('/usr/bin/textutil', ['-convert', 'txt', '-stdout', '--', path], { timeoutMs: 20_000 });
    return result.code === 0 && !result.timedOut ? result.stdout.slice(0, maxChars) : undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
