import { missingChromiumBuilds } from './builds.js';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import type { ProcessRunner } from '../../core/process/types.js';
import { readBrowserConfig } from './config.js';

const INSTALL_FIX =
  'Playwright is not installed: run `pnpm add playwright && npx playwright install chromium` in the ax-kit folder';
const CHROMIUM_FIX = 'npx playwright install chromium';

export interface BrowserCheck {
  id: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface BrowserCheckDeps {
  run: ProcessRunner;
  resolvePlaywright(): Promise<boolean>;
  /** Entries in ~/Library/Caches/ms-playwright. */
  cacheDirs(): Promise<string[]>;
  /** The exact builds this Playwright needs that are missing (undefined: could not tell, the cache list decides). */
  missingBuilds?(): Promise<string[] | undefined>;
  config: unknown;
}

async function quietly<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

function check(id: string, ok: boolean, detail: string, fix: string): BrowserCheck {
  return { id, ok, detail, ...(ok ? {} : { fix }) };
}

/** Doctor checks for the configured adapter. Never installs anything itself. */
export async function browserChecks(deps: BrowserCheckDeps): Promise<BrowserCheck[]> {
  const config = readBrowserConfig(deps.config);
  if (config.adapter === 'cli') {
    const command = config.cli.command;
    const found = await quietly(async () => {
      const answer = await deps.run('/usr/bin/which', [command], { timeoutMs: 10_000 });
      return answer.code === 0 && !answer.timedOut;
    }, false);
    return [
      check(
        'browser.cli',
        found,
        found ? `Found ${command}.` : `Could not find ${command}.`,
        `Install ${command} or set plugins["connector.browser"].cli.command to an absolute path.`,
      ),
    ];
  }

  const resolved = await quietly(() => deps.resolvePlaywright(), false);
  const dirs = await quietly(() => deps.cacheDirs(), []);
  const missing = deps.missingBuilds === undefined ? undefined : await quietly(() => deps.missingBuilds?.() ?? Promise.resolve(undefined), undefined);
  // an older build in the cache is not enough: Playwright launches its own revision
  const chromium = missing !== undefined ? missing.length === 0 : dirs.some((entry) => entry.toLowerCase().startsWith('chromium'));
  return [
    check(
      'browser.playwright',
      resolved,
      resolved ? 'The playwright package is installed.' : 'The playwright package is not installed.',
      INSTALL_FIX,
    ),
    check(
      'browser.chromium',
      chromium,
      chromium ? 'A Chromium build is installed.' : 'No Chromium build is installed.',
      CHROMIUM_FIX,
    ),
  ];
}

/** Production deps for `doctor`. Resolution stays local to this Mac; nothing is downloaded. */
export function defaultBrowserCheckDeps(home: string = homedir()): BrowserCheckDeps {
  return {
    run: nodeProcessRunner,
    resolvePlaywright: () => {
      try {
        import.meta.resolve('playwright');
        return Promise.resolve(true);
      } catch {
        return Promise.resolve(false);
      }
    },
    cacheDirs: async () => {
      try {
        return await readdir(join(home, 'Library', 'Caches', 'ms-playwright'));
      } catch {
        return [];
      }
    },
    missingBuilds: () => missingChromiumBuilds(nodeProcessRunner),
    config: undefined,
  };
}
