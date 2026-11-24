import { describe, expect, it } from 'vitest';
import { buildApp } from '../../../src/app/build.js';
import { discordChannel } from '../../../src/channels/discord/plugin.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { greetingSkill } from '../../../src/skills/greeting/plugin.js';
import { MemorySecretStore } from '../../../src/core/secrets/memory.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { parseConfig } from '../../../src/core/config/load.js';
import { flush } from '../../core/helpers.js';
import { FakeDiscordPort } from './fake-port.js';

const OWNER = '11111111111111111';
const STRANGER = '22222222222222222';

function config() {
  return parseConfig({
    version: 1,
    assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
    owner: { discordUserId: OWNER },
  });
}

async function makeApp(port: FakeDiscordPort, secrets: MemorySecretStore) {
  const parsed = config();
  return await buildApp({
    config: parsed,
    secrets,
    log: silentLogger,
    plugins: [
      discordChannel({ ownerUserId: parsed.owner.discordUserId!, port: () => port, expiresMinutes: 30 }),
      greetingSkill(),
    ],
    storePath: ':memory:',
  });
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
}

async function idle(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) await flush();
}

function message(overrides: Partial<Parameters<FakeDiscordPort['emitMessage']>[0]> = {}) {
  return {
    id: 'in-1',
    channelId: 'dm-1',
    authorId: OWNER,
    authorIsBot: false,
    isDm: true,
    content: '안녕',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('discord channel plugin', () => {
  it('replies once to an owner DM greeting', async () => {
    const port = new FakeDiscordPort();
    const app = await makeApp(port, new MemorySecretStore({ 'discord.bot-token': 'x' }));
    await app.start();
    try {
      expect(port.logins).toEqual(['x']);
      port.emitMessage(message());
      await until(() => port.sent.length > 0);

      expect(port.sent).toHaveLength(1);
      expect(port.sent[0]?.channelId).toBe('dm-1');
      expect(port.sent[0]?.payload.content).toContain('비서');
    } finally {
      await app.stop('test');
    }
    expect(port.destroyed).toBe(true);
  });

  it('accepts guild messages from the owner', async () => {
    const port = new FakeDiscordPort();
    const app = await makeApp(port, new MemorySecretStore({ 'discord.bot-token': 'x' }));
    await app.start();
    try {
      port.emitMessage(message({ isDm: false, channelId: 'guild-1', content: 'hello' }));
      await until(() => port.sent.length > 0);
      expect(port.sent[0]?.channelId).toBe('guild-1');
      expect(port.sent[0]?.payload.content).toContain('비서');
    } finally {
      await app.stop('test');
    }
  });

  it('does not reply to a non-owner greeting', async () => {
    const port = new FakeDiscordPort();
    const app = await makeApp(port, new MemorySecretStore({ 'discord.bot-token': 'x' }));
    await app.start();
    try {
      port.emitMessage(message({ authorId: STRANGER }));
      await idle();
      expect(port.sent).toHaveLength(0);
    } finally {
      await app.stop('test');
    }
  });

  it('does not reply to a bot message', async () => {
    const port = new FakeDiscordPort();
    const app = await makeApp(port, new MemorySecretStore({ 'discord.bot-token': 'x' }));
    await app.start();
    try {
      port.emitMessage(message({ authorIsBot: true }));
      await idle();
      expect(port.sent).toHaveLength(0);
    } finally {
      await app.stop('test');
    }
  });

  it('provides an owner channel that sends to the owner DM and caches the channel', async () => {
    const port = new FakeDiscordPort();
    const app = await makeApp(port, new MemorySecretStore({ 'discord.bot-token': 'x' }));
    await app.start();
    try {
      const owner = app.host.capability(Contracts.ownerChannel);
      expect(owner).toBeDefined();
      await owner?.send({ text: '아침 브리핑' });
      await owner?.send({ text: '한 번 더' });

      expect(port.dms).toEqual([OWNER]);
      expect(port.sent.map((sent) => sent.channelId)).toEqual([`dm-${OWNER}`, `dm-${OWNER}`]);
      expect(port.sent[0]?.payload.content).toBe('아침 브리핑');
    } finally {
      await app.stop('test');
    }
  });

  it('fails to start with a message naming the secret command', async () => {
    const port = new FakeDiscordPort();
    const app = await makeApp(port, new MemorySecretStore());
    await expect(app.start()).rejects.toThrow(/ax-kit secret set discord\.bot-token/);
    await app.stop('test');
  });
});
