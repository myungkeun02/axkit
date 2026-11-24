import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ensureSwiftHelper } from '../../core/process/swift-helper.js';
import type { ProcessRunner, RunResult } from '../../core/process/types.js';
import type { AxSnapshot } from './ax-tree.js';
import { parseSnapshot, ScreenReadError } from './ax-tree.js';

const TIMEOUT_MS = 20_000;

const TrustedOutput = z.object({ ok: z.literal(true), trusted: z.boolean() });

/** Read-only access to the Accessibility tree of a running app. */
export interface AxReader {
  trusted(): Promise<boolean>;
  dump(bundleIds: readonly string[], maxNodes?: number): Promise<AxSnapshot>;
}

export interface HelperAxReaderOptions {
  run: ProcessRunner;
  /** Resolved once by `ensureSwiftHelper`; a build failure surfaces as a plain Error. */
  helperPath: () => Promise<string>;
}

/** Runs the bundled helper binary. It never presses, types, activates or scrolls. */
export class HelperAxReader implements AxReader {
  constructor(private readonly options: HelperAxReaderOptions) {}

  async trusted(): Promise<boolean> {
    const parsed = TrustedOutput.safeParse(this.json(await this.execute(['trusted'])));
    if (!parsed.success) throw new ScreenReadError('helper', 'ax-read returned an unexpected document.');
    return parsed.data.trusted;
  }

  async dump(bundleIds: readonly string[], maxNodes?: number): Promise<AxSnapshot> {
    if (bundleIds.length === 0) throw new ScreenReadError('helper', 'At least one bundle id is required.');
    const args = ['dump', '--bundle', bundleIds.join(',')];
    if (maxNodes !== undefined) args.push('--max-nodes', String(maxNodes));
    return parseSnapshot(this.json(await this.execute(args)));
  }

  private async execute(args: readonly string[]): Promise<RunResult> {
    const helper = await this.options.helperPath();
    let result: RunResult;
    try {
      result = await this.options.run(helper, args, { timeoutMs: TIMEOUT_MS });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ScreenReadError('failed', `Could not run ax-read: ${message}`);
    }
    if (result.timedOut) throw new ScreenReadError('timeout', 'ax-read did not answer in time.');
    if (result.code !== 0) throw new ScreenReadError('helper', `ax-read exited with code ${result.code}.`);
    return result;
  }

  private json(result: RunResult): unknown {
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new ScreenReadError('helper', 'ax-read returned invalid JSON.');
    }
  }
}

/** Memoized helper path; the source hash decides when the binary is rebuilt. */
export function swiftHelperPath(binDir: string, run: ProcessRunner): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= ensureSwiftHelper(
      {
        name: 'ax-read',
        sourcePath: fileURLToPath(new URL('./ax-read.swift', import.meta.url)),
        binDir,
      },
      { run },
    );
    return pending;
  };
}
