import { access, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLAYWRIGHT_CLI, missingChromiumBuilds } from '../connectors/browser/builds.js';
import { nodeProcessRunner } from '../core/process/node-runner.js';
import { resolveCommand } from '../core/process/resolve-command.js';
import type { Prompter } from './prompter.js';
import type { BasicStepDeps } from './setup-defaults.js';
import type { TranscribeStepDeps } from './setup-transcribe.js';
import { setupTranscriber } from './setup-transcribe.js';
import type { AppDevStepDeps } from './setup-app-dev.js';
import { findLocalProjects } from '../skills/dev-assist/find-projects.js';
import { runAttached } from './update.js';

const AX_KIT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The exact Chromium builds this checkout's Playwright needs are on disk (an older cached build does not count). */
async function hasChromium(): Promise<boolean> {
  const missing = await missingChromiumBuilds(nodeProcessRunner);
  if (missing !== undefined) return missing.length === 0;
  const entries = await readdir(join(homedir(), 'Library', 'Caches', 'ms-playwright')).catch(() => [] as string[]);
  return entries.some((entry) => entry.toLowerCase().startsWith('chromium'));
}

/** The real Mac for the app-improvement step: installs run on this terminal so their progress shows. */
export function nodeAppDevDeps(prompter: Prompter): AppDevStepDeps {
  return {
    prompter,
    userHome: homedir(),
    hasCommand: async (name) => resolveCommand(name) !== undefined,
    exists: async (path) => await access(path).then(() => true, () => false),
    run: (cmd, args, cwd) => runAttached(cmd, args, cwd),
    readFile: (path) => readFile(path, 'utf8'),
    writeFile: (path, text) => writeFile(path, text),
    ...(process.env['AX_KIT_APPS_BASE'] !== undefined ? { base: process.env['AX_KIT_APPS_BASE'] } : {}),
    brewPrefix: async () => (await nodeProcessRunner('brew', ['--prefix'], { timeoutMs: 10_000 })).stdout,
  };
}

/**
 * The real Mac for the basics step. `transcribe` is the transcription deps without the prompter; the installs run on
 * this terminal so their progress shows.
 */
export function nodeBasicDeps(prompter: Prompter, transcribe: Omit<TranscribeStepDeps, 'prompter'>): Omit<BasicStepDeps, 'prompter' | 'secrets' | 'existing'> {
  const gh = resolveCommand('gh');
  return {
    ensureBrowser: async () => {
      if (await hasChromium()) return true;
      prompter.say('브라우저 심부름에 쓸 Chromium을 받아요…');
      await runAttached(PLAYWRIGHT_CLI, ['install', 'chromium'], AX_KIT_ROOT);
      return await hasChromium();
    },
    // asked with its size: a 1.6GB download is not forced on anyone
    installTranscriber: () => setupTranscriber({ ...transcribe, prompter }),
    hasCode: async () => (await findLocalProjects(nodeProcessRunner)).some((project) => project.hasCommits),
    ...(gh !== undefined
      ? {
          github: {
            token: async () => {
              const result = await nodeProcessRunner(gh, ['auth', 'token'], { timeoutMs: 10_000 });
              const token = result.stdout.trim();
              return result.code === 0 && token !== '' ? token : undefined;
            },
            login: async () => {
              const code = await runAttached(gh, ['auth', 'login', '--web', '--git-protocol', 'https']);
              if (code === 0) await runAttached(gh, ['auth', 'setup-git']);
              return code;
            },
          },
        }
      : {}),
  };
}
