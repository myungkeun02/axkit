import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  configPath,
  defaultHome,
  loadConfig,
  parseConfig,
  saveConfig,
} from '../../src/core/config/load.js';
import type { ConfigInput } from '../../src/core/config/schema.js';

const validRaw: ConfigInput = {
  version: 1,
  assistant: { name: 'Jarvis', language: 'en', timezone: 'Asia/Seoul' },
  owner: { discordUserId: '12345678901234567' },
  llm: {
    providers: [{ id: 'anthropic', kind: 'anthropic', priceIn: 3, priceOut: 15 }],
    routes: [
      { providerId: 'anthropic', model: 'claude-haiku-5-5', tiers: ['fast'], maxSensitivity: 'public' },
    ],
    budget: { dailyUsd: 2, monthlyUsd: 40 },
  },
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ax-kit-config-'));
  tempDirs.push(dir);
  return dir;
}

describe('parseConfig', () => {
  it('accepts a valid config and applies defaults', () => {
    const config = parseConfig(validRaw);
    expect(config.assistant.name).toBe('Jarvis');
    expect(config.policy).toEqual({ confirmWrites: false, expiresMinutes: 30 });
    expect(config.llm.providers[0]?.priceIn).toBe(3);
  });

  it('rejects an unknown time zone', () => {
    const raw = { ...validRaw, assistant: { name: 'A', language: 'ko', timezone: 'Nowhere/City' } };
    try {
      parseConfig(raw);
      throw new Error('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).issues).toContain('assistant.timezone: unknown time zone "Nowhere/City"');
    }
  });

  it('rejects routes pointing at unknown providers', () => {
    const raw: ConfigInput = {
      ...validRaw,
      llm: {
        providers: [{ id: 'anthropic', kind: 'anthropic' }],
        routes: [{ providerId: 'ghost', model: 'm', tiers: ['fast'], maxSensitivity: 'public' }],
      },
    };
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    try {
      parseConfig(raw);
    } catch (error) {
      expect((error as ConfigError).issues).toContain('llm.routes.0.providerId: unknown provider "ghost"');
    }
  });

  it('reports schema issues with paths', () => {
    try {
      parseConfig({
        version: 1,
        assistant: { name: '', language: 'en', timezone: '' },
        owner: { discordUserId: 'abc' },
      });
      throw new Error('expected ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const issues = (error as ConfigError).issues;
      expect(issues.some((issue) => issue.startsWith('assistant.name:'))).toBe(true);
      expect(issues.some((issue) => issue.startsWith('owner.discordUserId:'))).toBe(true);
    }
  });
});

describe('paths', () => {
  it('computes the default home and config path', () => {
    expect(defaultHome({ AX_KIT_HOME: '/tmp/custom' })).toBe('/tmp/custom');
    expect(defaultHome({})).toMatch(/\.ax-kit$/);
    expect(configPath('/tmp/home')).toBe('/tmp/home/config.json');
  });
});

describe('loadConfig and saveConfig', () => {
  it('round-trips through disk with mode 0600', async () => {
    const dir = await tempDir();
    const path = join(dir, 'nested', 'config.json');

    await saveConfig(path, validRaw);
    const loaded = await loadConfig(path);

    expect(loaded).toMatchObject({ version: 1, assistant: { name: 'Jarvis', timezone: 'Asia/Seoul' } });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('rejects a missing file', async () => {
    const dir = await tempDir();
    await expect(loadConfig(join(dir, 'absent.json'))).rejects.toThrow(/not found/);
  });

  it('rejects invalid JSON', async () => {
    const dir = await tempDir();
    const path = join(dir, 'config.json');
    await writeFile(path, '{not json');
    await expect(loadConfig(path)).rejects.toThrow(/not valid JSON/);
  });

  it('validates before writing', async () => {
    const dir = await tempDir();
    const path = join(dir, 'config.json');
    const invalid = { ...validRaw, assistant: { name: 'A', language: 'en', timezone: 'Bad/Zone' } } as ConfigInput;
    await expect(saveConfig(path, invalid)).rejects.toThrow(ConfigError);
  });
});
