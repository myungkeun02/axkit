import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import { ensureSwiftHelper } from '../../core/process/swift-helper.js';
import type { ProcessRunner } from '../../core/process/types.js';
import { VisionTextRecognizer } from './recognizer.js';

export interface MacosOcrConnectorOptions {
  /** Where the compiled helper is cached; defaults to ~/.ax-kit/bin. */
  binDir?: string;
  run?: ProcessRunner;
  helperPath?: () => Promise<string>;
}

export interface OcrCheck {
  id: 'ocr.swiftc';
  ok: boolean;
  detail: string;
  fix?: string;
}

const CHECK_TIMEOUT_MS = 20_000;
const DETAIL_CHARS = 200;

function firstLine(value: string): string {
  return (value.split(/\r?\n/)[0] ?? '').trim().slice(0, DETAIL_CHARS);
}

/** Doctor check: whether swiftc can build the Vision helper on this Mac. */
export async function ocrCheck(run: ProcessRunner): Promise<OcrCheck> {
  let detail = 'swiftc is not installed';
  try {
    const result = await run('swiftc', ['--version'], { timeoutMs: CHECK_TIMEOUT_MS });
    if (result.code === 0) {
      return { id: 'ocr.swiftc', ok: true, detail: firstLine(result.stdout) || 'swiftc is available' };
    }
    detail = firstLine(result.stderr) || detail;
  } catch {
    // Starting the compiler failed; the install hint below is the fix either way.
  }
  return { id: 'ocr.swiftc', ok: false, detail, fix: 'xcode-select --install' };
}

/** Text recognition from images and PDFs with Apple's Vision framework, entirely on this Mac. */
export function macosOcrConnector(options: MacosOcrConnectorOptions = {}): Plugin {
  const run = options.run ?? nodeProcessRunner;
  const binDir = options.binDir ?? join(homedir(), '.ax-kit', 'bin');

  let helper: Promise<string> | undefined;
  const compile = (): Promise<string> => {
    helper ??= ensureSwiftHelper(
      {
        name: 'ax-ocr',
        sourcePath: fileURLToPath(new URL('./ocr.swift', import.meta.url)),
        binDir,
        frameworks: ['Vision', 'PDFKit'],
      },
      { run },
    ).catch((error: unknown) => {
      helper = undefined;
      throw error;
    });
    return helper;
  };
  const helperPath = options.helperPath ?? compile;

  return {
    manifest: {
      id: 'connector.macos-ocr',
      kind: 'connector',
      title: 'Text recognition on this Mac (Vision)',
    },
    setup(ctx) {
      ctx.provide(Contracts.ocr, new VisionTextRecognizer({ run, helperPath }));
    },
  };
}
