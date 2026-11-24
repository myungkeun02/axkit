import { describe, expect, it } from 'vitest';
import { emitPreview, preview, setup, NOW } from './helpers.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('chat-inbox replies', () => {
  it('sends one digest for rooms older than the threshold and deletes entries past seven days', async () => {
    const context = await setup();
    await emitPreview(
      context,
      preview({ room: '민수', text: '그거 확인해줘', at: new Date(NOW.getTime() - 4 * HOUR), ref: 'p1' }),
    );
    await emitPreview(
      context,
      preview({ room: '지훈', text: '사진 보냈어', at: new Date(NOW.getTime() - HOUR), ref: 'p2' }),
    );
    await emitPreview(
      context,
      preview({ room: '서연', text: '잘 지내', at: new Date(NOW.getTime() - 8 * DAY), ref: 'p3' }),
    );

    await context.scheduler.run('chat-inbox.replies', NOW);

    expect(context.notifier.notices).toHaveLength(1);
    const notice = context.notifier.notices[0]!;
    expect(notice).toMatchObject({ kind: 'chat.replies', dedupeKey: '2026-11-17' });
    expect(notice.text).toContain('답장 안 한 대화 1개');
    expect(notice.text).toContain('- 카톡 · 민수 · 4시간 전 · "그거 확인해줘"');
    expect(notice.text).not.toContain('지훈');
    expect(notice.text).not.toContain('서연');
    expect(notice.choices?.map((choice) => choice.id)).toEqual([
      'chat-inbox.done:kakao:민수',
      'chat-inbox.mute:replies',
    ]);

    const pending = await context.kv.get<{ room: string }[]>('pending');
    expect(pending?.map((entry) => entry.room).sort()).toEqual(['민수', '지훈']);
  });

  it('stays quiet when every pending room is younger than the threshold', async () => {
    const context = await setup();
    await emitPreview(context, preview({ at: new Date(NOW.getTime() - HOUR) }));

    await context.scheduler.run('chat-inbox.replies', NOW);

    expect(context.notifier.notices).toHaveLength(0);
    expect(await context.kv.get<unknown[]>('pending')).toHaveLength(1);
  });

  it('lists at most five rooms and one mute choice', async () => {
    const context = await setup();
    for (let index = 0; index < 7; index += 1) {
      await emitPreview(
        context,
        preview({
          room: `친구${index}`,
          text: `메시지 ${index}`,
          at: new Date(NOW.getTime() - (index + 4) * HOUR),
          ref: `many-${index}`,
        }),
      );
    }

    await context.scheduler.run('chat-inbox.replies', NOW);

    const choices = context.notifier.notices[0]?.choices ?? [];
    expect(choices.filter((choice) => choice.id.startsWith('chat-inbox.done:'))).toHaveLength(5);
    expect(choices.at(-1)?.id).toBe('chat-inbox.mute:replies');
  });

  it('offers the pending list through the chat.pending tool', async () => {
    const context = await setup();
    await emitPreview(context, preview({ room: '민수', text: '그거 확인해줘' }));

    const outcome = await context.ctx.tools.execute('chat.pending', {});

    expect(outcome.status).toBe('done');
    expect(outcome.status === 'done' ? outcome.output : undefined).toMatchObject({
      count: 1,
      pending: [{ room: '민수', app: 'kakao', lastText: '그거 확인해줘' }],
    });
  });
});
