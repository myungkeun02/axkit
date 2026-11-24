import { stat as fsStat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { RecognizedText, TextRecognizer } from '../../core/contracts/ocr.js';
import { extensionOf } from '../../core/files/filter.js';
import type { ProcessRunner } from '../../core/process/types.js';

const EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'heic', 'heif', 'tif', 'tiff', 'gif', 'bmp', 'webp']);
const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 100_000;
const DEFAULT_MAX_PAGES = 10;
const MIN_MAX_PAGES = 1;
const MAX_MAX_PAGES = 50;
const DEFAULT_LANGUAGES = ['ko-KR', 'en-US'] as const;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
// The first Vision call loads its model, which took about 25 s on this Mac.
const TIMEOUT_MS = 120_000;

const outputSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    method: z.enum(['pdf-text', 'vision']),
    pages: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export interface FileFacts {
  size: number;
  isFile: boolean;
}

export interface VisionTextRecognizerOptions {
  run: ProcessRunner;
  helperPath: () => Promise<string>;
  stat?: (path: string) => Promise<FileFacts>;
}

async function defaultStat(path: string): Promise<FileFacts> {
  const info = await fsStat(path);
  return { size: info.size, isFile: info.isFile() };
}

function pagesOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_PAGES;
  return Math.min(MAX_MAX_PAGES, Math.max(MIN_MAX_PAGES, Math.trunc(value)));
}

function languagesOf(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return DEFAULT_LANGUAGES;
  if (value.length === 0 || value.some((language) => !LANGUAGE.test(language))) {
    throw new Error('invalid recognition language');
  }
  return value;
}

async function checkFile(
  path: string,
  stat: (target: string) => Promise<FileFacts>,
): Promise<void> {
  let facts: FileFacts;
  try {
    facts = await stat(path);
  } catch {
    throw new Error('unreadable');
  }
  if (!facts.isFile) throw new Error('not a regular file');
  if (facts.size > MAX_BYTES) throw new Error('the file is too large');
}

/** Reads text from a local image or PDF with the compiled Vision helper. Nothing leaves this Mac. */
export class VisionTextRecognizer implements TextRecognizer {
  private readonly run: ProcessRunner;
  private readonly helperPath: () => Promise<string>;
  private readonly stat: (path: string) => Promise<FileFacts>;

  constructor(options: VisionTextRecognizerOptions) {
    this.run = options.run;
    this.helperPath = options.helperPath;
    this.stat = options.stat ?? defaultStat;
  }

  async recognize(
    path: string,
    opts: { languages?: readonly string[]; maxPages?: number } = {},
  ): Promise<RecognizedText> {
    if (!isAbsolute(path)) throw new Error('the path must be absolute');
    if (!EXTENSIONS.has(extensionOf(path))) throw new Error('unsupported file type');
    const languages = languagesOf(opts.languages);
    const maxPages = pagesOf(opts.maxPages);
    await checkFile(path, this.stat);

    const helper = await this.helperPath();
    const result = await this.run(
      helper,
      [path, '--languages', languages.join(','), '--max-pages', String(maxPages)],
      { timeoutMs: TIMEOUT_MS },
    );
    if (result.timedOut) throw new Error('text recognition timed out');
    if (result.code !== 0) throw new Error('text recognition failed');

    let raw: unknown;
    try {
      raw = JSON.parse(result.stdout);
    } catch {
      throw new Error('text recognition failed');
    }
    const parsed = outputSchema.safeParse(raw);
    if (!parsed.success) throw new Error('text recognition failed');
    if (!parsed.data.ok) throw new Error(parsed.data.error);

    return {
      method: parsed.data.method,
      pages: parsed.data.pages,
      text: parsed.data.text.slice(0, MAX_TEXT_CHARS),
    };
  }
}
