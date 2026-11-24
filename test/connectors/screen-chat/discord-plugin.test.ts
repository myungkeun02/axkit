import { describe, expect, it } from 'vitest';
import type { AxSnapshot } from '../../../src/connectors/screen-chat/ax-tree.js';
import { discordAppConnector } from '../../../src/connectors/screen-chat/plugin-discord.js';
import type { ChatPreview } from '../../../src/core/contracts/index.js';
import { createTestContext } from '../../support/context.js';
import { FakeAxReader, HOME, NOW, axSnapshot, fakeRunner } from './helpers.js';
import type { TreeNode } from './helpers.js';

function dmScreen(messages: readonly string[], links: readonly string[] = []): AxSnapshot {
  const roots: TreeNode[] = links.map((label) => ({ role: 'AXLink', label }));
  for (const message of messages) roots.push({ role: 'AXGroup', label: message });
  return axSnapshot([{ title: '@민수 - Discord', roots }]);
}

function channelScreen(messages: readonly string[]): AxSnapshot {
  return axSnapshot([
    {
      title: '#general | Example Server - Discord',
      roots: messages.map((message) => ({ role: 'AXGroup', label: message })),
    },
  ]);
}

async function setup(snapshot: AxSnapshot) {
  const reader = new FakeAxReader();
  reader.snapshot = snapshot;
  const { run } = fakeRunner();
  const context = createTestContext();
  const events: ChatPreview[] = [];
  context.bus.on('chat.preview', (preview) => {
    events.push(preview);
  });
  await discordAppConnector({
    reader,
    run,
    home: HOME,
    fs: { exists: async () => false, listDir: async () => [] },
  }).setup(context.ctx);
  return { reader, context, events };
}

describe('discord-app connector', () => {
  it('registers a polling job and no send tool', async () => {
    const { context } = await setup(dmScreen([]));

    expect(context.scheduler.jobs.get('discord-app.poll')?.schedule).toEqual({
      kind: 'every',
      seconds: 300,
    });
    expect(context.registry.list()).toHaveLength(0);
  });

  it('seeds the first poll and emits a changed DM message afterwards', async () => {
    const { reader, context, events } = await setup(
      dmScreen(['민수 , 안녕하세요 , 오후 3:20'], ['읽지 않음, 민수 (다이렉트 메시지)']),
    );

    await context.scheduler.run('discord-app.poll', NOW);
    expect(events).toHaveLength(0);
    expect(reader.dumpCalls[0]?.bundleIds).toEqual([
      'com.hnc.Discord',
      'com.hnc.Discord.ptb',
      'com.hnc.DiscordCanary',
    ]);

    await context.scheduler.run('discord-app.poll', NOW);
    expect(events).toHaveLength(0);

    reader.snapshot = dmScreen(
      ['민수 , 새 메시지 , 오후 3:21'],
      ['읽지 않음, 민수 (다이렉트 메시지)'],
    );
    await context.scheduler.run('discord-app.poll', NOW);

    expect(events).toEqual([
      expect.objectContaining({
        app: 'discord',
        room: '민수',
        text: '민수: 새 메시지',
        unread: null,
        direct: true,
      }),
    ]);
  });

  it('emits a new unread DM with empty text and its mention count', async () => {
    const { reader, context, events } = await setup(axSnapshot([{ title: '친구 - Discord', roots: [] }]));
    await context.scheduler.run('discord-app.poll', NOW);

    reader.snapshot = dmScreen([], ['멘션 2개, 민수 (다이렉트 메시지)']);
    await context.scheduler.run('discord-app.poll', NOW);

    expect(events).toEqual([
      expect.objectContaining({ room: '민수', text: '', unread: 2, direct: true }),
    ]);
  });

  it('names a channel room with its server', async () => {
    const { reader, context, events } = await setup(channelScreen(['민수 , 첫 메시지 , 오후 3:20']));
    await context.scheduler.run('discord-app.poll', NOW);

    reader.snapshot = channelScreen(['민수 , 바뀐 메시지 , 오후 3:21']);
    await context.scheduler.run('discord-app.poll', NOW);

    expect(events).toEqual([
      expect.objectContaining({
        room: '#general (Example Server)',
        text: '민수: 바뀐 메시지',
        direct: false,
      }),
    ]);
  });

  it('keeps DM and message trackers in distinct key-value keys', async () => {
    const { context } = await setup(dmScreen(['민수 , 안녕하세요 , 오후 3:20']));
    await context.scheduler.run('discord-app.poll', NOW);

    expect(await context.kv.get('dm:seen')).toBeDefined();
    expect(await context.kv.get('messages:seen')).toBeDefined();
  });

  it('ignores bot messages', async () => {
    const { reader, context, events } = await setup(dmScreen(['도우미 앱 , 첫 소식 , 오후 3:20']));
    await context.scheduler.run('discord-app.poll', NOW);

    reader.snapshot = dmScreen(['도우미 앱 , 새 소식 , 오후 3:21']);
    await context.scheduler.run('discord-app.poll', NOW);

    expect(events).toHaveLength(0);
  });
});
