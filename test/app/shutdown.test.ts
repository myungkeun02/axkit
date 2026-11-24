import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app/build.js';
import { parseConfig } from '../../src/core/config/load.js';
import type { IncomingMessage } from '../../src/core/conversation/types.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import type { Plugin } from '../../src/core/plugin/types.js';
import { Caps } from '../../src/core/plugin/types.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';

const message: IncomingMessage = { id: 'm1', conversation: { channelId: 'channel.test', address: 'a' }, authorId: 'owner', fromOwner: true, text: '오래 걸리는 일', receivedAt: new Date() };

describe('app stop', () => {
  it('lets a running turn deliver its reply before the channels close', async () => {
    const events: string[] = [];
    const plugin: Plugin = {
      manifest: { id: 'channel.test', kind: 'channel', title: 'test' },
      setup(ctx) {
        ctx.use(Caps.channels).register({
          id: 'channel.test',
          replier: { reply: async (_to, outgoing) => void events.push(`reply ${outgoing.text}`) },
          owner: { send: async () => undefined },
        });
        ctx.registerHandler({
          id: 'slow',
          priority: 5,
          handle: async (incoming, replier) => {
            await new Promise((resolve) => setTimeout(resolve, 30));
            await replier.reply(incoming.conversation, { text: '끝났어요' });
            return 'handled';
          },
        });
        return { stop: async () => void events.push('channel closed') };
      },
    };
    const app = await buildApp({
      config: parseConfig({ version: 1, assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' }, owner: { discordUserId: '11111111111111111' } }),
      secrets: new MemorySecretStore(),
      log: silentLogger,
      plugins: [plugin],
      storePath: ':memory:',
    });
    await app.start();
    void app.bus.emit('message.received', message);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await app.stop('test');
    expect(events).toEqual(['reply 끝났어요', 'channel closed']);
  });
});
