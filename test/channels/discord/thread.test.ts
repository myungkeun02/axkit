import { describe, expect, it } from 'vitest';
import { discordChannel } from '../../../src/channels/discord/plugin.js';
import type { IncomingMessage } from '../../../src/core/conversation/types.js';
import { Caps } from '../../../src/core/plugin/types.js';
import { ChannelHub } from '../../../src/core/hub/hub.js';
import { createTestContext } from '../../support/context.js';
import { flush } from '../../core/helpers.js';
import { FakeDiscordPort } from './fake-port.js';

const OWNER = '11111111111111111';

async function started() {
  const port = new FakeDiscordPort();
  const test = createTestContext({ capabilities: { [Caps.channels.id]: new ChannelHub() } });
  await test.secrets.set('discord.bot-token', 'x');
  const received: IncomingMessage[] = [];
  test.bus.on('message.received', (message) => void received.push(message));
  const lifecycle = await discordChannel({ ownerUserId: OWNER, port: () => port, expiresMinutes: 30 }).setup(test.ctx);
  await lifecycle?.start?.();
  return { port, received };
}

describe('discord intake', () => {
  it('puts the owner’s DM in the owner thread and leaves guild rooms alone', async () => {
    const { port, received } = await started();
    const base = { authorId: OWNER, authorIsBot: false, content: '안녕', createdAt: new Date('2026-01-01T00:00:00Z') };
    port.emitMessage({ ...base, id: 'd1', channelId: 'dm-1', isDm: true });
    port.emitMessage({ ...base, id: 'g1', channelId: 'guild-room', isDm: false });
    await flush();
    expect(received.map((message) => [message.id, message.conversation.thread])).toEqual([
      ['d1', 'owner'],
      ['g1', undefined],
    ]);
  });

  it('puts a choice pressed in the owner’s DM in the owner thread', async () => {
    const { port, received } = await started();
    port.press({ customId: 'choice:yes', userId: OWNER, channelId: `dm-${OWNER}`, messageId: 'x1', ack: async () => undefined });
    for (let attempt = 0; attempt < 5; attempt += 1) await flush();
    expect(received[0]?.conversation.thread).toBe('owner');
  });
});
