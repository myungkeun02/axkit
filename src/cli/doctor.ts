import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { Config, SecretReader } from '../core/index.js';
import { ConfigError, configPath, loadConfig, openSqliteStore } from '../core/index.js';
import {
  defaultExec,
  koreanPackChecks,
  appChannelCheck,
  phoneCheck,
  shortcutsCheck,
  tailscaleChecks,
} from './doctor-phone.js';
import type { Exec } from './tailscale.js';
import { optionalChecks } from '../app/optional-checks.js';
import type { OptionalCheck } from '../app/optional-checks.js';
import { opsChecks } from '../app/ops-checks.js';

export interface DoctorCheck {
  id: string;
  ok: boolean;
  severity: 'error' | 'warn';
  detail: string;
  fix?: string;
}

export interface DoctorDeps {
  home: string;
  secrets: SecretReader;
  nodeVersion?: string;
  platform?: string;
  checkLaunchd?: () => Promise<boolean>;
  /** Injected in tests; production uses the real process runner. */
  exec?: Exec;
  /** Injected in tests so "last signal 3 h ago" is deterministic. */
  now?: () => Date;
  /** Checks for the optional plugins that are on; injected in tests. */
  optional?: (config: Config) => Promise<OptionalCheck[]>;
  /** Pauses, notice load, documents and uncommitted code; injected in tests. */
  ops?: (config: Config) => Promise<OptionalCheck[]>;
}

const MIN_NODE = { major: 22, minor: 13 } as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readNodeVersion(raw: string): { major: number; minor: number } | undefined {
  const match = /^v?(\d+)\.(\d+)/.exec(raw);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return undefined;
  return { major, minor };
}

function nodeCheck(raw: string): DoctorCheck {
  const parsed = readNodeVersion(raw);
  const ok =
    parsed !== undefined &&
    (parsed.major > MIN_NODE.major || (parsed.major === MIN_NODE.major && parsed.minor >= MIN_NODE.minor));
  return {
    id: 'node',
    ok,
    severity: 'error',
    detail: ok ? raw : `${raw} (need ${MIN_NODE.major}.${MIN_NODE.minor} or newer)`,
    ...(ok ? {} : { fix: `install Node ${MIN_NODE.major}.${MIN_NODE.minor}+ from https://nodejs.org` }),
  };
}

function platformCheck(platform: string): DoctorCheck {
  const ok = platform === 'darwin';
  return {
    id: 'platform',
    ok,
    severity: 'warn',
    detail: platform,
    ...(ok ? {} : { fix: 'ax-kit is supported on macOS only' }),
  };
}

function displayPath(path: string): string {
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

async function configCheck(home: string): Promise<{ check: DoctorCheck; config: Config | undefined }> {
  const path = configPath(home);
  const shown = displayPath(path);
  try {
    await access(path);
  } catch {
    return {
      check: { id: 'config', ok: false, severity: 'error', detail: `missing ${shown}`, fix: 'run: ax-kit setup' },
      config: undefined,
    };
  }
  try {
    const config = await loadConfig(path);
    return { check: { id: 'config', ok: true, severity: 'error', detail: `${shown} valid` }, config };
  } catch (error) {
    const detail =
      error instanceof ConfigError && error.issues.length > 0 ? error.issues.join('; ') : errorMessage(error);
    return {
      check: { id: 'config', ok: false, severity: 'error', detail: `invalid ${shown}: ${detail}`, fix: 'run: ax-kit setup' },
      config: undefined,
    };
  }
}

async function secretCheck(secrets: SecretReader, name: string):
  Promise<{ ok: boolean; detail: string }> {
  try {
    const present = (await secrets.get(name)) !== undefined;
    return { ok: present, detail: `${name} ${present ? 'present' : 'missing'}` };
  } catch (error) {
    return { ok: false, detail: `${name} unreadable (${errorMessage(error)})` };
  }
}

async function providerChecks(config: Config, secrets: SecretReader): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const provider of config.llm.providers) {
    if (provider.apiKeySecret === undefined) continue;
    const result = await secretCheck(secrets, provider.apiKeySecret);
    checks.push({
      id: `secret.${provider.id}`,
      ok: result.ok,
      severity: 'error',
      detail: result.detail,
      ...(result.ok ? {} : { fix: `run: ax-kit secret set ${provider.apiKeySecret}` }),
    });
  }
  return checks;
}

async function sqliteCheck(): Promise<DoctorCheck> {
  try {
    const store = openSqliteStore(':memory:');
    await store.close();
    return { id: 'sqlite', ok: true, severity: 'error', detail: 'opened :memory:' };
  } catch (error) {
    return {
      id: 'sqlite',
      ok: false,
      severity: 'error',
      detail: `could not open: ${errorMessage(error)}`,
      fix: 'use Node 22.13 or newer (node:sqlite)',
    };
  }
}

async function homeCheck(home: string): Promise<DoctorCheck> {
  try {
    const info = await stat(home);
    const mode = info.mode & 0o777;
    const ok = mode === 0o700;
    return {
      id: 'home',
      ok,
      severity: 'error',
      detail: ok ? `${home} mode 0700` : `${home} mode 0${mode.toString(8)}`,
      ...(ok ? {} : { fix: `chmod 700 ${home}` }),
    };
  } catch {
    return { id: 'home', ok: false, severity: 'error', detail: `missing ${home}`, fix: `mkdir -m 700 ${home}` };
  }
}

export async function runDoctor(deps: DoctorDeps): Promise<DoctorCheck[]> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? defaultExec;
  const now = deps.now?.() ?? new Date();
  const checks: DoctorCheck[] = [nodeCheck(deps.nodeVersion ?? process.version), platformCheck(platform)];

  const configResult = await configCheck(deps.home);
  checks.push(configResult.check);

  const channel = configResult.config?.channel ?? 'discord';
  const discord = channel === 'app' ? undefined : await secretCheck(deps.secrets, 'discord.bot-token');
  if (discord !== undefined) checks.push({
    id: 'secret.discord',
    ok: discord.ok,
    severity: 'error',
    detail: discord.detail,
    ...(discord.ok ? {} : { fix: 'run: ax-kit secret set discord.bot-token' }),
  });

  if (configResult.config !== undefined) {
    checks.push(...(await providerChecks(configResult.config, deps.secrets)));
    if (configResult.config.assistant.language === 'ko') {
      checks.push(...(await koreanPackChecks(deps.secrets)));
    }
  }

  checks.push(await sqliteCheck(), await homeCheck(deps.home));
  checks.push(...(await tailscaleChecks(exec)));
  if (platform === 'darwin') checks.push(await shortcutsCheck(exec));
  checks.push(await phoneCheck(deps.home, now));
  if (channel !== 'discord') checks.push(await appChannelCheck(deps.home, now));
  if (configResult.config !== undefined) {
    const config = configResult.config;
    const optional = deps.optional ?? ((c: Config) => optionalChecks({ config: c, home: deps.home, secrets: deps.secrets }));
    for (const check of await optional(config)) checks.push({ ...check, severity: 'warn' });
    const ops = deps.ops ?? ((c: Config) => opsChecks({ config: c, home: deps.home, now }));
    for (const check of await ops(config)) checks.push({ ...check, severity: 'warn' });
  }

  if (deps.checkLaunchd !== undefined) {
    const ok = await deps.checkLaunchd().catch(() => false);
    checks.push({
      id: 'launchd',
      ok,
      severity: 'warn',
      detail: ok ? 'launchd agent loaded' : 'launchd agent not loaded',
      ...(ok ? {} : { fix: 'run: ax-kit service install' }),
    });
  }

  return checks;
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  return checks
    .map((check) => {
      const mark = check.ok ? '[ok]' : '[!!]';
      const fix = !check.ok && check.fix !== undefined ? `  -> ${check.fix}` : '';
      return `${mark} ${check.id}  ${check.detail}${fix}`;
    })
    .join('\n');
}

export function doctorFailed(checks: readonly DoctorCheck[]): boolean {
  return checks.some((check) => !check.ok && check.severity === 'error');
}
