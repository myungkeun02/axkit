import { access } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Config } from '../core/config/schema.js';
import type { ProcessRunner } from '../core/process/types.js';
import type { SecretReader } from '../core/secrets/types.js';
import { nodeProcessRunner } from '../core/process/node-runner.js';
import { HelperAxReader, screenChatChecks, swiftHelperPath } from '../connectors/screen-chat/index.js';
import type { AxReader } from '../connectors/screen-chat/index.js';
import { browserChecks, defaultBrowserCheckDeps } from '../connectors/browser/checks.js';
import type { BrowserCheckDeps } from '../connectors/browser/checks.js';
import { ocrCheck } from '../connectors/macos-ocr/plugin.js';
import { macAppsChecks, macAppsClient } from '../connectors/mac-apps/plugin.js';
import type { MacAppsClient } from '../connectors/mac-apps/client.js';
import { remindersCheck, remindersClient } from '../connectors/apple-reminders/plugin.js';
import type { RemindersClient } from '../connectors/apple-reminders/client.js';
import { todoSource } from './plugins-workspace.js';

export interface OptionalCheck {
  id: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface OptionalCheckDeps {
  config: Config;
  /** The ax-kit home (~/.ax-kit); helpers are compiled into its bin folder. */
  home: string;
  secrets: SecretReader;
  run?: ProcessRunner;
  reader?: AxReader;
  exists?: (path: string) => Promise<boolean>;
  browser?: BrowserCheckDeps;
  macApps?: MacAppsClient;
  reminders?: RemindersClient;
}

const enabled = (config: Config, id: string): boolean => config.plugins[id]?.enabled === true;

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function repoPaths(config: Config): string[] {
  const repos = config.plugins['skill.dev-assist']?.['repos'];
  if (!Array.isArray(repos)) return [];
  return repos.flatMap((repo: unknown) => {
    const path = typeof repo === 'object' && repo !== null ? (repo as { path?: unknown }).path : undefined;
    return typeof path === 'string' ? [path] : [];
  });
}

async function devAssistChecks(deps: OptionalCheckDeps, exists: (path: string) => Promise<boolean>): Promise<OptionalCheck[]> {
  const hasToken = await deps.secrets.get('github.token').then((value) => value !== undefined, () => false);
  const checks: OptionalCheck[] = [
    {
      id: 'dev.github-token',
      ok: hasToken,
      detail: hasToken ? 'github.token present' : 'github.token missing',
      ...(hasToken ? {} : { fix: 'run: ax-kit secret set github.token' }),
    },
  ];
  const paths = repoPaths(deps.config);
  if (paths.length === 0) {
    checks.push({ id: 'dev.repos', ok: false, detail: 'no repository configured', fix: 'run: ax-kit setup' });
  }
  for (const path of paths) {
    const ok = isAbsolute(path) && (await exists(join(path, '.git')));
    checks.push({
      id: 'dev.repo',
      ok,
      detail: ok ? `${path} is a git clone` : `${path} is not a git clone`,
      ...(ok ? {} : { fix: 'clone the repository there or fix plugins["skill.dev-assist"].repos' }),
    });
  }
  return checks;
}

/**
 * Doctor lines for the optional plugins that are turned on. They check permissions and tools only: no chat app is
 * read, no page is opened and no GitHub call is made.
 */
export async function optionalChecks(deps: OptionalCheckDeps): Promise<OptionalCheck[]> {
  const { config } = deps;
  const run = deps.run ?? nodeProcessRunner;
  const exists = deps.exists ?? pathExists;
  const checks: OptionalCheck[] = [];

  const kakao = enabled(config, 'connector.kakao-desktop');
  const discord = enabled(config, 'connector.discord-app');
  if (kakao || discord) {
    const reader = deps.reader ?? new HelperAxReader({ run, helperPath: swiftHelperPath(join(deps.home, 'bin'), run) });
    checks.push(...(await screenChatChecks({ reader, appExists: exists, kakao, discord })));
  }
  if (enabled(config, 'connector.browser')) {
    const base = deps.browser ?? defaultBrowserCheckDeps();
    checks.push(...(await browserChecks({ ...base, config: config.plugins['connector.browser'] })));
  }
  if (enabled(config, 'connector.macos-ocr')) checks.push(await ocrCheck(run));
  if (enabled(config, 'skill.dev-assist')) checks.push(...(await devAssistChecks(deps, exists)));
  const binDir = join(deps.home, 'bin');
  if (enabled(config, 'connector.mac-apps')) {
    checks.push(...(await macAppsChecks(run, deps.macApps ?? macAppsClient({ run, binDir }))));
  }
  if (todoSource(config) === 'synced') {
    checks.push(await remindersCheck(deps.reminders ?? remindersClient({ run, binDir })));
  }
  return checks;
}
