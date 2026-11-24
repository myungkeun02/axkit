import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app/build.js';
import { parseConfig } from '../../src/core/config/load.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { discordChannel } from '../../src/channels/discord/plugin.js';
import { greetingSkill } from '../../src/skills/greeting/plugin.js';
import { assistantSkill } from '../../src/skills/assistant/plugin.js';
import { todoSkill } from '../../src/skills/todo/plugin.js';
import { briefingSkill } from '../../src/skills/briefing/plugin.js';
import { FakeDiscordPort } from '../channels/discord/fake-port.js';
import { flush } from '../core/helpers.js';

const OWNER = '11111111111111111';

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await flush();
}

describe('app end to end (fake Discord, no LLM provider)', () => {
  it('starts the M1 plugin set, sends the first briefing and answers the owner', async () => {
    const port = new FakeDiscordPort();
    const secrets = new MemorySecretStore();
    await secrets.set('discord.bot-token', 'token-1');
    const app = await buildApp({
      config: parseConfig({
        version: 1,
        assistant: { name: '나비', language: 'ko', timezone: 'Asia/Seoul' },
        owner: { discordUserId: OWNER },
      }),
      secrets,
      log: silentLogger,
      plugins: [
        discordChannel({ ownerUserId: OWNER, expiresMinutes: 30, port: () => port }),
        greetingSkill(),
        assistantSkill({ loadSystemPrompt: async () => 'You are {{persona}}. {{tools}}' }),
        todoSkill(),
        briefingSkill(),
      ],
      storePath: ':memory:',
    });
    await app.start();
    try {
      await settle();
      const briefing = port.sent.find((entry) => entry.payload.content.includes('브리핑'));
      expect(briefing?.channelId).toBe(`dm-${OWNER}`);
      expect(briefing?.payload.content).toContain('Google 캘린더가 연결되지 않았어요');

      const base = { channelId: 'c1', authorIsBot: false, isDm: false, createdAt: new Date() };
      port.emitMessage({ ...base, id: 'm1', authorId: OWNER, content: '안녕' });
      port.emitMessage({ ...base, id: 'm2', authorId: '22222222222222222', content: '안녕' });
      port.emitMessage({ ...base, id: 'm3', authorId: OWNER, content: '내일 할 일 알려줘' });
      await settle();

      const replies = port.sent.filter((entry) => entry.channelId === 'c1').map((entry) => entry.payload.content);
      expect(replies).toHaveLength(2);
      expect(replies[0]).toContain('나비예요');
      expect(replies[1]).toContain('ax-kit setup');
      expect(app.tools.list().map((tool) => tool.name)).toEqual(
        expect.arrayContaining(['todo.add', 'todo.list', 'todo.remove', 'briefing.now']),
      );
    } finally {
      await app.stop('test');
    }
  });
});
