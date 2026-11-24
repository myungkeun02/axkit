import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Config, ConfigInput } from './schema.js';
import { ConfigSchema } from './schema.js';

export class ConfigError extends Error {
  constructor(
    readonly issues: string[],
    message = 'Invalid configuration',
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

interface IssueLike {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

function formatIssue(issue: IssueLike): string {
  const path = issue.path.map((part) => String(part)).join('.');
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map(formatIssue));
  }
  const config = result.data;
  const issues: string[] = [];
  if (!isValidTimeZone(config.assistant.timezone)) {
    issues.push(`assistant.timezone: unknown time zone "${config.assistant.timezone}"`);
  }
  const providerIds = new Set(config.llm.providers.map((provider) => provider.id));
  config.llm.routes.forEach((route, index) => {
    if (!providerIds.has(route.providerId)) {
      issues.push(`llm.routes.${index}.providerId: unknown provider "${route.providerId}"`);
    }
  });
  if (issues.length > 0) throw new ConfigError(issues);
  return config;
}

export function defaultHome(env: Record<string, string | undefined> = process.env): string {
  return env.AX_KIT_HOME ?? join(homedir(), '.ax-kit');
}

export function configPath(home: string): string {
  return join(home, 'config.json');
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ConfigError([], `Config file not found: ${path}`);
    }
    throw new ConfigError([], `Could not read config file: ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ConfigError([], `Config file is not valid JSON: ${path}`);
  }
  return parseConfig(raw);
}

export async function saveConfig(path: string, config: ConfigInput): Promise<void> {
  const parsed = parseConfig(config);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
