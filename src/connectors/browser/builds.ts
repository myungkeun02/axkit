import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ProcessRunner } from '../../core/process/types.js';

/** This checkout's own Playwright CLI, so the browser builds match the installed package version. */
export const PLAYWRIGHT_CLI = fileURLToPath(new URL('../../../node_modules/.bin/playwright', import.meta.url));

/** The install folders `playwright install --dry-run chromium` names, from its output. */
export function installLocations(output: string): string[] {
  return [...output.matchAll(/Install location:\s+(\S.*)$/gm)].map((match) => (match[1] ?? '').trim()).filter((path) => path !== '');
}

/**
 * The Chromium builds this Playwright version needs that are not on disk yet (an older build in the cache does not
 * count: Playwright looks for its own revision). Undefined when the CLI could not tell.
 */
export async function missingChromiumBuilds(run: ProcessRunner, cli = PLAYWRIGHT_CLI): Promise<string[] | undefined> {
  const result = await run(cli, ['install', '--dry-run', 'chromium'], { timeoutMs: 30_000 }).catch(() => undefined);
  if (result === undefined || result.code !== 0) return undefined;
  const missing: string[] = [];
  for (const path of installLocations(result.stdout)) {
    try {
      await access(path);
    } catch {
      missing.push(path);
    }
  }
  return missing;
}
