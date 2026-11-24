import { describe, expect, it } from 'vitest';
import type { NoticeDelivered, OwnerChannel } from '../../../src/core/contracts/notify.js';
import type { OutgoingMessage } from '../../../src/core/conversation/types.js';
import { backoffMs, MAX_SEND_ATTEMPTS } from '../../../src/core/notify/held-queue.js';
import { QuietHoursNotifier } from '../../../src/core/notify/quiet-notifier.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { FakeClock, MapKeyValueStore } from '../helpers.js';

const HOUR_MS = 3_600_000;
const QUIET = { from: '22:00', to: '07:00' };

class FlakyChannel implements OwnerChannel {
  readonly sent: OutgoingMessage[] = [];
  readonly urgentFlags: boolean[] = [];
  failing: (message: OutgoingMessage) => boolean = () => false;
  async send(message: OutgoingMessage, options?: { urgent?: boolean }): Promise<void> {
    if (this.failing(message)) throw new Error('down');
    this.sent.push(message);
    this.urgentFlags.push(options?.urgent === true);
  }
}

function at(hhmm: string, day = 17): Date {
  return new Date(`2026-11-${day}T${hhmm}:00+09:00`);
}

function make(clock: FakeClock, channel: OwnerChannel, kv = new MapKeyValueStore(), delivered: NoticeDelivered[] = [], cap?: number) {
  return new QuietHoursNotifier({
    channel: () => channel,
    clock,
    timeZone: 'Asia/Seoul',
    quietHours: QUIET,
    kv,
    log: silentLogger,
    dailyBudget: 0,
    onDelivered: (event) => void delivered.push(event),
    ...(cap !== undefined ? { perKindHourlyCap: cap } : {}),
  });
}

describe('QuietHoursNotifier held queue', () => {
  it('keeps undelivered notices after a failed morning flush and retries them with backoff', async () => {
    const clock = new FakeClock(at('23:00'));
    const channel = new FlakyChannel();
    const kv = new MapKeyValueStore();
    const notifier = make(clock, channel, kv);
    await notifier.notify({ kind: 'a', text: '하나' });
    await notifier.notify({ kind: 'b', text: '둘' });
    channel.failing = (message) => message.text === '둘';

    await clock.advance(8 * HOUR_MS); // 07:00 flush
    expect(channel.sent.map((message) => message.text)).toEqual(['하나']);
    const held = await kv.get<{ notice: { text: string }; attempts: number }[]>('notify.held');
    expect(held?.map((entry) => [entry.notice.text, entry.attempts])).toEqual([['둘', 1]]);

    channel.failing = () => false;
    await clock.advance(backoffMs(1));
    expect(channel.sent.map((message) => message.text)).toEqual(['하나', '둘']);
    expect(await kv.get('notify.held')).toBeUndefined();
  });

  it('folds more than two held notices into one "밤사이 소식" message, keeping cards apart', async () => {
    const clock = new FakeClock(at('23:00'));
    const channel = new FlakyChannel();
    const delivered: NoticeDelivered[] = [];
    const notifier = make(clock, channel, new MapKeyValueStore(), delivered);
    const choice = { id: 'open', label: '보기' };
    await notifier.notify({ kind: 'mail', text: '새 메일' });
    await notifier.notify({ kind: 'watch.price', text: '가격이 내렸어요', choices: [choice] });
    await notifier.notify({ kind: 'parcel', text: '택배 도착' });
    await notifier.notify({ kind: 'bill', text: '카드 대금' });

    await clock.advance(8 * HOUR_MS);
    expect(channel.sent).toEqual([
      { text: '밤사이 소식 3건이에요.\n- 새 메일\n- 택배 도착\n- 카드 대금' },
      { text: '가격이 내렸어요', choices: [choice] },
    ]);
    expect(delivered.map((event) => event.kind)).toEqual(['overnight', 'watch.price']);
    expect(delivered[0]?.at).toBe(at('07:00', 18).toISOString());
  });

  it('sends two held notices one by one', async () => {
    const clock = new FakeClock(at('23:00'));
    const channel = new FlakyChannel();
    const notifier = make(clock, channel);
    await notifier.notify({ kind: 'mail', text: '새 메일' });
    await notifier.notify({ kind: 'parcel', text: '택배 도착' });
    await clock.advance(8 * HOUR_MS);
    expect(channel.sent.map((message) => message.text)).toEqual(['새 메일', '택배 도착']);
  });

  it('folds again when the folded message itself failed, and keeps all of them until it goes', async () => {
    const clock = new FakeClock(at('23:00'));
    const channel = new FlakyChannel();
    const notifier = make(clock, channel);
    for (const text of ['가', '나', '다']) await notifier.notify({ kind: 'k', text });
    channel.failing = () => true;
    await clock.advance(8 * HOUR_MS);
    expect(channel.sent).toEqual([]);
    channel.failing = () => false;
    await clock.advance(backoffMs(1));
    expect(channel.sent.map((message) => message.text)).toEqual(['밤사이 소식 3건이에요.\n- 가\n- 나\n- 다']);
  });

  it('skips a held notice whose expiresAt passed overnight', async () => {
    const clock = new FakeClock(at('23:00'));
    const channel = new FlakyChannel();
    const notifier = make(clock, channel);
    await notifier.notify({ kind: 'todo.reminder', text: '10분 전이에요', expiresAt: at('23:40').toISOString() });
    await notifier.notify({ kind: 'mail', text: '새 메일' });

    await clock.advance(8 * HOUR_MS);
    expect(channel.sent.map((message) => message.text)).toEqual(['새 메일']);
  });

  it('puts a daytime send failure on the held queue and sends it once the channel is back', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FlakyChannel();
    const delivered: NoticeDelivered[] = [];
    const notifier = make(clock, channel, new MapKeyValueStore(), delivered);
    channel.failing = () => true;
    expect(await notifier.notify({ kind: 'mail', text: '새 메일' })).toBe('held');
    expect(delivered).toEqual([]);

    await clock.advance(backoffMs(1)); // still down: attempt 2
    channel.failing = () => false;
    await clock.advance(backoffMs(2));
    expect(channel.sent.map((message) => message.text)).toEqual(['새 메일']);
    expect(delivered).toEqual([{ kind: 'mail', text: '새 메일', at: clock.now().toISOString() }]);
  });

  it('retries a failed urgent notice even during quiet hours and passes urgency to the channel', async () => {
    const clock = new FakeClock(at('23:00'));
    const channel = new FlakyChannel();
    const notifier = make(clock, channel);
    channel.failing = () => true;
    expect(await notifier.notify({ kind: 'reminder', text: '지금 출발', urgent: true })).toBe('held');
    channel.failing = () => false;
    await clock.advance(backoffMs(1));
    expect(channel.sent.map((message) => message.text)).toEqual(['지금 출발']);
    expect(channel.urgentFlags).toEqual([true]);
  });

  it('gives up after the last attempt', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FlakyChannel();
    const kv = new MapKeyValueStore();
    const notifier = make(clock, channel, kv);
    channel.failing = () => true;
    await notifier.notify({ kind: 'mail', text: '새 메일' });
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) await clock.advance(backoffMs(attempt));
    expect(await kv.get('notify.held')).toBeUndefined();
    notifier.stop();
  });

  it('folds notices over the hourly cap into the next digest', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FlakyChannel();
    const delivered: NoticeDelivered[] = [];
    const notifier = make(clock, channel, new MapKeyValueStore(), delivered, 1);
    expect(await notifier.notify({ kind: 'watch.price', text: '하나' })).toBe('sent');
    expect(await notifier.notify({ kind: 'watch.price', text: '둘' })).toBe('held');
    expect(await notifier.flushDigest()).toBe('sent');
    expect(channel.sent.at(-1)?.text).toContain('- 둘');
    expect(delivered.map((event) => event.kind)).toEqual(['watch.price', 'digest']);
  });

  it('restores a queue written in the old plain-notice format', async () => {
    const kv = new MapKeyValueStore();
    await kv.set('notify.held', [{ kind: 'mail', text: '예전 알림' }]);
    const channel = new FlakyChannel();
    await make(new FakeClock(at('08:00')), channel, kv).restore();
    expect(channel.sent.map((message) => message.text)).toEqual(['예전 알림']);
  });
});
