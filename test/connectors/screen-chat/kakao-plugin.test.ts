import { describe, expect, it } from 'vitest';
import { ScreenReadError } from '../../../src/connectors/screen-chat/ax-tree.js';
import type { AxSnapshot } from '../../../src/connectors/screen-chat/ax-tree.js';
import { kakaoDesktopConnector } from '../../../src/connectors/screen-chat/plugin-kakao.js';
import type { ChatPreview } from '../../../src/core/contracts/index.js';
import { createTestContext } from '../../support/context.js';
import {
  FakeAxReader,
  HOME,
  NOW,
  RecordingLogger,
  axSnapshot,
  badgeNode,
  fakeRunner,
  rowNode,
  stoppedSnapshot,
  tableNode,
  textNode,
} from './helpers.js';

function kakaoScreen(preview: string): AxSnapshot {
  return axSnapshot([
    {
      title: 'KakaoTalk',
      roots: [
        tableNode([
          rowNode([textNode('민수'), textNode(preview), badgeNode('2')]),
          rowNode([textNode('영희'), textNode('내일 봐요'), badgeNode('0')]),
        ]),
      ],
    },
  ]);
}

async function setup() {
  const reader = new FakeAxReader();
  reader.snapshot = kakaoScreen('안녕하세요');
  const { run } = fakeRunner();
  const context = createTestContext({ config: { pollSeconds: 120, listLimit: 5 } });
  const log = new RecordingLogger();
  context.ctx.log = log;
  const events: ChatPreview[] = [];
  context.bus.on('chat.preview', (preview) => {
    events.push(preview);
  });
  await kakaoDesktopConnector({
    reader,
    run,
    home: HOME,
    fs: { exists: async () => false, listDir: async () => [] },
  }).setup(context.ctx);
  return { reader, context, log, events };
}

describe('kakao-desktop connector', () => {
  it('registers the send tool and a polling job with the configured interval', async () => {
    const { context } = await setup();

    expect(context.scheduler.jobs.get('kakao-desktop.poll')?.schedule).toEqual({
      kind: 'every',
      seconds: 120,
    });
    expect(context.registry.get('kakao.send')).toBeDefined();
  });

  it('seeds on the first poll and emits chat.preview for later changes only', async () => {
    const { reader, context, events } = await setup();

    await context.scheduler.run('kakao-desktop.poll', NOW);
    expect(events).toHaveLength(0);
    expect(reader.dumpCalls[0]?.bundleIds).toEqual(['com.kakao.KakaoTalkMac']);

    await context.scheduler.run('kakao-desktop.poll', NOW);
    expect(events).toHaveLength(0);

    reader.snapshot = kakaoScreen('새 메시지');
    await context.scheduler.run('kakao-desktop.poll', NOW);

    expect(events).toEqual([
      expect.objectContaining({
        app: 'kakao',
        room: '민수',
        text: '새 메시지',
        unread: 2,
        at: NOW,
      }),
    ]);
  });

  it('returns quietly when KakaoTalk is not running', async () => {
    const { reader, context, events } = await setup();
    reader.snapshot = stoppedSnapshot();

    await context.scheduler.run('kakao-desktop.poll', NOW);

    expect(events).toHaveLength(0);
  });

  it('warns once when Accessibility permission is missing', async () => {
    const { reader, context, log, events } = await setup();
    reader.failure = new ScreenReadError('accessibility', 'not granted');

    await context.scheduler.run('kakao-desktop.poll', NOW);
    await context.scheduler.run('kakao-desktop.poll', NOW);

    expect(events).toHaveLength(0);
    expect(log.warnings.filter((message) => message.includes('Accessibility'))).toHaveLength(1);
  });
});
