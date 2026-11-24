import { describe, expect, it } from 'vitest';
import { collectMoney, emitPreview, preview, setup, NOW } from './helpers.js';

describe('chat-inbox intake', () => {
  it('routes a kakao card-company room to money.notice and does nothing else', async () => {
    const context = await setup();
    const money = collectMoney(context);

    await emitPreview(context, preview({ room: '현대카드', text: '승인 12,000원', unread: 2 }));

    expect(money).toHaveLength(1);
    expect(money[0]).toMatchObject({
      source: 'chat',
      sender: '현대카드',
      text: '승인 12,000원',
      at: NOW,
    });
    expect(context.people.calls).toHaveLength(0);
    expect(context.notifier.notices).toHaveLength(0);
    expect(await context.kv.get('pending')).toBeUndefined();
    expect(await context.kv.get('queue')).toBeUndefined();
  });

  it('does not treat a discord room as a card notice', async () => {
    const context = await setup();
    const money = collectMoney(context);

    await emitPreview(context, preview({ app: 'discord', room: 'Example Card', text: '결제 알림' }));

    expect(money).toHaveLength(0);
    expect(context.notifier.notices).toHaveLength(0);
  });

  it('records a code-written interaction and never copies the message body', async () => {
    const context = await setup();

    await emitPreview(context, preview({ room: '민수', text: '내일 3시에 강남역', unread: 2 }));

    expect(context.people.calls).toHaveLength(1);
    const call = context.people.calls[0]!;
    expect(call.identity).toEqual({ name: '민수' });
    expect(call.interaction).toMatchObject({ channel: 'chat', summary: '카카오톡 대화', at: NOW.toISOString() });
    expect(call.interaction.summary).not.toContain('강남역');
    expect(call.interaction.ref).toBeDefined();
  });

  it('skips contact memory for group rooms and channels marked as not direct', async () => {
    const context = await setup();

    await emitPreview(context, preview({ room: '민수, 지훈, 서연, 예린' }));
    await emitPreview(context, preview({ room: '가족 (5)' }));
    await emitPreview(context, preview({ room: '민수', direct: false }));

    expect(context.people.calls).toHaveLength(0);
    expect(await context.kv.get<unknown[]>('pending')).toHaveLength(3);
  });

  it('clears the pending entry when the room is read and stops there', async () => {
    const context = await setup();
    await emitPreview(context, preview({ unread: 2 }));
    expect(await context.kv.get<unknown[]>('pending')).toHaveLength(1);

    await emitPreview(context, preview({ text: '내일 3시에 강남역', unread: 0 }));

    expect(await context.kv.get<unknown[]>('pending')).toHaveLength(0);
    expect(context.people.calls).toHaveLength(1);
    expect(await context.kv.get('queue')).toBeUndefined();
  });

  it('keeps the first sighting time while refreshing the latest line', async () => {
    const context = await setup();
    const first = new Date(NOW.getTime() - 2 * 3_600_000);
    await emitPreview(context, preview({ text: '첫 번째 줄', at: first }));
    await emitPreview(context, preview({ text: '두 번째 줄' }));

    const pending = await context.kv.get<{ firstAt: string; lastText: string }[]>('pending');
    expect(pending).toHaveLength(1);
    expect(pending?.[0]?.firstAt).toBe(first.toISOString());
    expect(pending?.[0]?.lastText).toBe('두 번째 줄');
  });
});
