import { describe, expect, it } from 'vitest';
import type { OutgoingMessage } from '../../../src/core/conversation/types.js';
import type { OwnerChannel } from '../../../src/core/contracts/notify.js';
import type { Logger } from '../../../src/core/log/types.js';
import type { QuietHours } from '../../../src/core/notify/quiet-window.js';
import { QuietHoursNotifier } from '../../../src/core/notify/quiet-notifier.js';
import { createLogger, silentLogger } from '../../../src/core/log/console-logger.js';
import { FakeClock, MapKeyValueStore } from '../helpers.js';

const HOUR_MS = 3_600_000;
const QUIET_22_07: QuietHours = { from: '22:00', to: '07:00' };

class FakeOwnerChannel implements OwnerChannel {
  readonly sent: OutgoingMessage[] = [];
  fail = false;
  async send(message: OutgoingMessage): Promise<void> {
    if (this.fail) throw new Error('channel down');
    this.sent.push(message);
  }
}

function at(hhmm: string, day = 17): Date {
  return new Date(`2026-11-${day}T${hhmm}:00+09:00`);
}

interface Options {
  clock: FakeClock;
  kv: MapKeyValueStore;
  channel: OwnerChannel | undefined;
  quietHours?: QuietHours;
  cap?: number;
  dedupeHours?: number;
  log?: Logger;
}

function make(opts: Options): QuietHoursNotifier {
  return new QuietHoursNotifier({
    channel: () => opts.channel,
    clock: opts.clock,
    timeZone: 'Asia/Seoul',
    ...(opts.quietHours !== undefined ? { quietHours: opts.quietHours } : {}),
    kv: opts.kv,
    log: opts.log ?? silentLogger,
    ...(opts.cap !== undefined ? { perKindHourlyCap: opts.cap } : {}),
    ...(opts.dedupeHours !== undefined ? { dedupeHours: opts.dedupeHours } : {}),
  });
}

function logger(lines: string[]): Logger {
  return createLogger({ level: 'debug', sink: (line) => lines.push(line) });
}

describe('QuietHoursNotifier', () => {
  it('sends immediately outside quiet hours', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv: new MapKeyValueStore(), channel, quietHours: QUIET_22_07 });

    expect(await notifier.notify({ kind: 'briefing.morning', text: '아침 브리핑' })).toBe('sent');
    expect(channel.sent).toEqual([{ text: '아침 브리핑' }]);
  });

  it('holds during quiet hours and flushes in order at the end, keeping choices', async () => {
    const clock = new FakeClock(at('23:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv: new MapKeyValueStore(), channel, quietHours: QUIET_22_07 });

    const choice = { id: 'open', label: '보기' };
    expect(await notifier.notify({ kind: 'watch.price', text: '가격이 내렸어요', choices: [choice] })).toBe('held');
    expect(await notifier.notify({ kind: 'todo.reminder', text: '할 일이 남았어요' })).toBe('held');
    expect(channel.sent).toHaveLength(0);

    await clock.advance(8 * HOUR_MS);
    expect(channel.sent).toEqual([
      { text: '가격이 내렸어요', choices: [choice] },
      { text: '할 일이 남았어요' },
    ]);
  });

  it('treats identical from and to as never quiet', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({
      clock,
      kv: new MapKeyValueStore(),
      channel,
      quietHours: { from: '09:00', to: '09:00' },
    });

    expect(await notifier.notify({ kind: 'briefing.morning', text: '아침 브리핑' })).toBe('sent');
  });

  it('lets urgent notices through quiet hours', async () => {
    const clock = new FakeClock(at('23:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv: new MapKeyValueStore(), channel, quietHours: QUIET_22_07 });

    expect(await notifier.notify({ kind: 'reminder', text: '지금 출발해야 해요', urgent: true })).toBe('sent');
    expect(channel.sent.map((message) => message.text)).toEqual(['지금 출발해야 해요']);
  });

  it('caps a kind per rolling hour (the rest wait for the digest) but never caps urgent notices', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv: new MapKeyValueStore(), channel, cap: 2 });
    const notice = { kind: 'watch.price', text: '가격 변동' };

    expect(await notifier.notify(notice)).toBe('sent');
    expect(await notifier.notify(notice)).toBe('sent');
    expect(await notifier.notify(notice)).toBe('held');
    expect(await notifier.notify({ ...notice, text: '급해요', urgent: true })).toBe('sent');
    expect(await notifier.notify(notice)).toBe('held');

    await clock.advance(61 * 60_000);
    expect(await notifier.notify(notice)).toBe('sent');
    expect(channel.sent).toHaveLength(4);
  });

  it('caps each kind separately', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv: new MapKeyValueStore(), channel, cap: 1 });

    expect(await notifier.notify({ kind: 'watch.price', text: '하나' })).toBe('sent');
    expect(await notifier.notify({ kind: 'watch.price', text: '둘' })).toBe('held');
    expect(await notifier.notify({ kind: 'briefing.morning', text: '셋' })).toBe('sent');
  });

  it('drops a duplicate kind and key inside the dedupe window', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv: new MapKeyValueStore(), channel });
    const notice = { kind: 'watch.price', text: '가격이 내렸어요', dedupeKey: 'item-1' };

    expect(await notifier.notify(notice)).toBe('sent');
    expect(await notifier.notify(notice)).toBe('dropped');
    expect(await notifier.notify({ ...notice, dedupeKey: 'item-2' })).toBe('sent');
    expect(channel.sent).toHaveLength(2);

    await clock.advance(12 * HOUR_MS + 1);
    expect(await notifier.notify(notice)).toBe('sent');
  });

  it('sends notices without a dedupe key every time', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv: new MapKeyValueStore(), channel });
    const notice = { kind: 'briefing.morning', text: '아침 브리핑' };

    expect(await notifier.notify(notice)).toBe('sent');
    expect(await notifier.notify(notice)).toBe('sent');
  });

  it('keeps dedupe stamps across a restart', async () => {
    const clock = new FakeClock(at('09:00'));
    const kv = new MapKeyValueStore();
    const channel = new FakeOwnerChannel();
    const notice = { kind: 'briefing.morning', text: '아침 브리핑', dedupeKey: '2026-11-17' };

    expect(await make({ clock, kv, channel }).notify(notice)).toBe('sent');
    expect(await make({ clock, kv, channel }).notify(notice)).toBe('dropped');
    expect(channel.sent).toHaveLength(1);
  });

  it('restores a held queue after a restart and flushes it when quiet ends', async () => {
    const kv = new MapKeyValueStore();
    const channel = new FakeOwnerChannel();
    const before = make({ clock: new FakeClock(at('23:00')), kv, channel, quietHours: QUIET_22_07 });
    expect(await before.notify({ kind: 'briefing.morning', text: '아침 브리핑' })).toBe('held');
    before.stop();

    const clock = new FakeClock(at('23:30'));
    const after = make({ clock, kv, channel, quietHours: QUIET_22_07 });
    await after.restore();
    expect(channel.sent).toHaveLength(0);

    await clock.advance(7.5 * HOUR_MS);
    expect(channel.sent.map((message) => message.text)).toEqual(['아침 브리핑']);
  });

  it('flushes a restored queue immediately when no longer quiet', async () => {
    const kv = new MapKeyValueStore();
    const channel = new FakeOwnerChannel();
    const before = make({ clock: new FakeClock(at('23:00')), kv, channel, quietHours: QUIET_22_07 });
    expect(await before.notify({ kind: 'briefing.morning', text: '아침 브리핑' })).toBe('held');

    const after = make({ clock: new FakeClock(at('08:00', 18)), kv, channel, quietHours: QUIET_22_07 });
    await after.restore();
    expect(channel.sent.map((message) => message.text)).toEqual(['아침 브리핑']);

    await after.restore();
    expect(channel.sent).toHaveLength(1);
  });

  it('warns and keeps the notice when no owner channel is available', async () => {
    const lines: string[] = [];
    const notifier = make({
      clock: new FakeClock(at('09:00')),
      kv: new MapKeyValueStore(),
      channel: undefined,
      log: logger(lines),
    });

    expect(await notifier.notify({ kind: 'briefing.morning', text: '아침 브리핑' })).toBe('held');
    expect(lines.join('')).toContain('no owner channel');
  });

  it('never throws when the channel send fails', async () => {
    const lines: string[] = [];
    const channel = new FakeOwnerChannel();
    channel.fail = true;
    const notifier = make({
      clock: new FakeClock(at('09:00')),
      kv: new MapKeyValueStore(),
      channel,
      log: logger(lines),
    });

    expect(await notifier.notify({ kind: 'briefing.morning', text: '아침 브리핑' })).toBe('held');
    expect(lines.join('')).toContain('sending failed');
  });

  it('stops its quiet timer on stop()', async () => {
    const clock = new FakeClock(at('23:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv: new MapKeyValueStore(), channel, quietHours: QUIET_22_07 });

    expect(await notifier.notify({ kind: 'briefing.morning', text: '아침 브리핑' })).toBe('held');
    notifier.stop();
    await clock.advance(8 * HOUR_MS);
    expect(channel.sent).toHaveLength(0);
  });
});

describe('QuietHoursNotifier mute', () => {
  it('drops a muted kind, keeps urgent ones and remembers across instances', async () => {
    const clock = new FakeClock(at('12:00'));
    const kv = new MapKeyValueStore();
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv, channel });

    await notifier.mute('chat.replies');
    expect(await notifier.notify({ kind: 'chat.replies', text: 'a' })).toBe('dropped');
    expect(await notifier.notify({ kind: 'chat.replies', text: 'b', urgent: true })).toBe('sent');
    expect(await notifier.notify({ kind: 'todo.reminder', text: 'c' })).toBe('sent');
    expect(await make({ clock, kv, channel }).muted()).toEqual(['chat.replies']);

    await notifier.unmute('chat.replies');
    expect(await notifier.notify({ kind: 'chat.replies', text: 'd' })).toBe('sent');
    expect(channel.sent.map((message) => message.text)).toEqual(['b', 'c', 'd']);
  });
});
