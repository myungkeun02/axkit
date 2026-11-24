import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openPhoneAdmin, phoneStorePath } from '../../src/app/phone.js';
import { configPath, saveConfig } from '../../src/core/config/load.js';
import type { ConfigInput } from '../../src/core/config/schema.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { openSqliteStore } from '../../src/core/store/sqlite.js';
import { KO_SECRET_NAMES } from '../../src/connectors/ko-life/secrets.js';
import { doctorFailed, formatDoctor, runDoctor } from '../../src/cli/doctor.js';
import type { Exec, ExecResult } from '../../src/cli/tailscale.js';

const directories: string[] = [];
const NOW = new Date('2026-11-17T12:00:00+09:00');

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'axkit-doctor-'));
  directories.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

interface ExecOptions {
  tailscale?: boolean;
  running?: boolean;
  funnel?: boolean;
  shortcuts?: boolean;
}

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };

function fakeExec(options: ExecOptions = {}): { calls: string[]; exec: Exec } {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'tailscale' && args[0] === 'version') {
      return options.tailscale === false ? { ...OK, code: 1 } : OK;
    }
    if (cmd === 'tailscale' && args[0] === 'status') {
      if (options.running === false) return { ...OK, code: 1 };
      return { ...OK, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.ts.net.' } }) };
    }
    if (cmd === 'tailscale' && args[0] === 'funnel') {
      return {
        ...OK,
        stdout: options.funnel === false ? '|-- /other x' : '|-- /m proxy http://127.0.0.1:47617/m',
      };
    }
    if (cmd === 'shortcuts') return options.shortcuts === false ? { ...OK, code: 1 } : OK;
    return { ...OK, code: 1 };
  };
  return { calls, exec };
}

function baseConfig(overrides: Partial<ConfigInput> = {}): ConfigInput {
  return {
    version: 1,
    assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
    owner: { discordUserId: '12345678901234567' },
    ...overrides,
  };
}

async function writeConfig(home: string, input: ConfigInput = baseConfig()): Promise<void> {
  await saveConfig(configPath(home), input);
}

function secretsWithDiscord(extra: Record<string, string> = {}): MemorySecretStore {
  return new MemorySecretStore({ 'discord.bot-token': 'token', ...extra });
}

describe('runDoctor', () => {
  it('reports a missing config with a fix on an empty home', async () => {
    const home = await tempHome();
    const { exec } = fakeExec();
    const checks = await runDoctor({ home, secrets: new MemorySecretStore(), exec });
    const config = checks.find((check) => check.id === 'config');

    expect(config).toMatchObject({ ok: false, severity: 'error', fix: 'run: ax-kit setup' });
    expect(config?.detail).toContain('missing');
    expect(doctorFailed(checks)).toBe(true);

    const text = formatDoctor(checks);
    expect(text).toContain('[!!] config');
    expect(text).toContain('-> run: ax-kit setup');
  });

  it('passes the config and provider secret checks when everything is present', async () => {
    const home = await tempHome();
    await writeConfig(
      home,
      baseConfig({
        llm: {
          providers: [
            {
              id: 'anthropic',
              kind: 'anthropic',
              apiKeySecret: 'llm.anthropic.api-key',
              priceIn: 3,
              priceOut: 15,
            },
          ],
          routes: [
            {
              providerId: 'anthropic',
              model: 'claude-sonnet-4-5',
              tiers: ['standard'],
              maxSensitivity: 'sensitive',
            },
          ],
        },
      }),
    );
    const secrets = secretsWithDiscord({ 'llm.anthropic.api-key': 'key' });
    const { exec } = fakeExec();

    const checks = await runDoctor({ home, secrets, exec, platform: 'darwin', now: () => NOW });
    expect(checks.find((check) => check.id === 'config')?.ok).toBe(true);
    expect(checks.find((check) => check.id === 'secret.discord')?.ok).toBe(true);
    expect(checks.find((check) => check.id === 'secret.anthropic')?.ok).toBe(true);
    expect(checks.find((check) => check.id === 'sqlite')?.ok).toBe(true);
    expect(doctorFailed(checks)).toBe(false);
  });

  it('checks tailscale, the funnel path, shortcuts and the Korean pack keys', async () => {
    const home = await tempHome();
    await writeConfig(home);
    const { exec, calls } = fakeExec();
    const secrets = secretsWithDiscord({ [KO_SECRET_NAMES[0] ?? '']: 'key' });

    const checks = await runDoctor({ home, secrets, exec, platform: 'darwin', now: () => NOW });
    const byId = (id: string) => checks.find((check) => check.id === id);

    expect(byId('tailscale.installed')).toMatchObject({ ok: true, severity: 'warn' });
    expect(byId('tailscale.running')).toMatchObject({ ok: true });
    expect(byId('tailscale.funnel')).toMatchObject({ ok: true });
    expect(byId('shortcuts')).toMatchObject({ ok: true });
    expect(calls.some((call) => call.includes('funnel status'))).toBe(true);

    const koChecks = checks.filter((check) => check.id.startsWith('secret.ko.'));
    expect(koChecks).toHaveLength(KO_SECRET_NAMES.length);
    expect(byId(`secret.${KO_SECRET_NAMES[0]}`)?.ok).toBe(true);
    expect(byId(`secret.${KO_SECRET_NAMES[1]}`)).toMatchObject({
      ok: false,
      fix: `run: ax-kit secret set ${KO_SECRET_NAMES[1]}`,
    });
    expect(byId(`secret.${KO_SECRET_NAMES[1]}`)?.detail).toContain('subway arrivals');
  });

  it('skips the Korean pack checks for other languages', async () => {
    const home = await tempHome();
    await writeConfig(
      home,
      baseConfig({ assistant: { name: 'assistant', language: 'en', timezone: 'Asia/Seoul' } }),
    );
    const { exec } = fakeExec();

    const checks = await runDoctor({ home, secrets: secretsWithDiscord(), exec, platform: 'darwin', now: () => NOW });
    expect(checks.some((check) => check.id.startsWith('secret.ko.'))).toBe(false);
  });

  it('warns about missing tailscale, a closed funnel and missing shortcuts with one-line fixes', async () => {
    const home = await tempHome();
    await writeConfig(home);
    const { exec } = fakeExec({ tailscale: false, shortcuts: false });

    const checks = await runDoctor({ home, secrets: secretsWithDiscord(), exec, platform: 'darwin', now: () => NOW });
    expect(checks.find((check) => check.id === 'tailscale.installed')).toMatchObject({
      ok: false,
      fix: 'install Tailscale: brew install --cask tailscale',
    });
    expect(checks.find((check) => check.id === 'tailscale.running')?.fix).toContain('tailscale up');
    expect(checks.find((check) => check.id === 'shortcuts')?.ok).toBe(false);
  });

  it('reports the funnel fix when /m is not served', async () => {
    const home = await tempHome();
    await writeConfig(home);
    const { exec } = fakeExec({ funnel: false });

    const checks = await runDoctor({ home, secrets: secretsWithDiscord(), exec, platform: 'darwin', now: () => NOW });
    expect(checks.find((check) => check.id === 'tailscale.funnel')).toMatchObject({
      ok: false,
      fix: 'tailscale funnel --bg --set-path /m http://127.0.0.1:47617/m',
    });
  });

  it('reports paired devices and the last signal age without any token material', async () => {
    const home = await tempHome();
    await writeConfig(home);
    const handle = openPhoneAdmin(home);
    const paired = await handle.admin.pair({ name: '내 아이폰', platform: 'ios' });
    await handle.close();

    const store = openSqliteStore(phoneStorePath(home));
    try {
      await store.kv('bridge.mobile').set('lastSeen', new Date(NOW.getTime() - 3 * 60 * 60_000).toISOString());
    } finally {
      await store.close();
    }

    const { exec } = fakeExec();
    const checks = await runDoctor({ home, secrets: secretsWithDiscord(), exec, platform: 'darwin', now: () => NOW });
    const phone = checks.find((check) => check.id === 'phone.devices');

    expect(phone?.ok).toBe(true);
    expect(phone?.detail).toBe('1 device(s), 1 active, last signal 3 h ago');
    expect(JSON.stringify(checks)).not.toContain(paired.device.tokenHash);
    expect(JSON.stringify(checks)).not.toContain(paired.token);
  });

  it('warns when no phone is paired yet', async () => {
    const home = await tempHome();
    await writeConfig(home);
    const { exec } = fakeExec();

    const checks = await runDoctor({ home, secrets: secretsWithDiscord(), exec, platform: 'darwin', now: () => NOW });
    expect(checks.find((check) => check.id === 'phone.devices')).toMatchObject({
      ok: false,
      severity: 'warn',
      fix: 'run: ax-kit phone pair',
    });
  });
});
