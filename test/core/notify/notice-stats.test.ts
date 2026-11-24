import { describe, expect, it } from 'vitest';
import type { OutgoingMessage } from '../../../src/core/conversation/types.js';
import type { OwnerChannel } from '../../../src/core/contracts/notify.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { QuietHoursNotifier } from '../../../src/core/notify/quiet-notifier.js';
import type { QuietHours } from '../../../src/core/notify/quiet-window.js';
import { KvNoticeStats } from '../../../src/core/notify/stats.js';
import { FakeClock, MapKeyValueStore } from '../helpers.js';

const HOUR_MS = 3_600_000;
const QUIET_22_07: QuietHours = { from: '22:00', to: '07:00' };

class FakeOwnerChannel implements OwnerChannel {
  readonly sent: OutgoingMessage[] = [];
  async send(message: OutgoingMessage): Promise<void> {
    this.sent.push(message);
  }
}

function at(hhmm: string, day = 17): Date {
  return new Date(`2026-11-${day}T${hhmm}:00+09:00`);
}

describe('KvNoticeStats', () => {
  it('sums the seven days ending today per kind, busiest first', async () => {
    const stats = new KvNoticeStats(new MapKeyValueStore(), 'Asia/Seoul');
    await stats.count(at('09:00', 17), 'watch.price', 'sent');
    await stats.count(at('10:00', 17), 'watch.price', 'sent');
    await stats.count(at('11:00', 16), 'watch.price', 'held');
    await stats.count(at('09:00', 11), 'watch.price', 'dropped');
    await stats.count(at('09:00', 10), 'watch.price', 'dropped');
    await stats.count(at('12:00', 17), 'todo.reminder', 'digested');

    expect(await stats.week(at('18:00', 17))).toEqual([
      { kind: 'watch.price', sent: 2, held: 1, digested: 0, dropped: 1 },
      { kind: 'todo.reminder', sent: 0, held: 0, digested: 1, dropped: 0 },
    ]);
  });

  it('counts over-budget days inside the requested window', async () => {
    const stats = new KvNoticeStats(new MapKeyValueStore(), 'Asia/Seoul');
    await stats.markOverBudget(at('09:00', 17));
    await stats.markOverBudget(at('09:00', 16));
    await stats.markOverBudget(at('09:00', 10));
    await stats.markOverBudget(at('09:00', 17));

    expect(await stats.overBudgetDays(at('18:00', 17), 7)).toBe(2);
    expect(await stats.overBudgetDays(at('18:00', 17), 8)).toBe(3);
    expect(await stats.overBudgetDays(at('18:00', 17), 0)).toBe(0);
  });

  it('keeps counts across instances sharing the store', async () => {
    const kv = new MapKeyValueStore();
    await new KvNoticeStats(kv, 'Asia/Seoul').count(at('09:00'), 'briefing.morning', 'sent');

    expect(await new KvNoticeStats(kv, 'Asia/Seoul').week(at('10:00', 18))).toEqual([
      { kind: 'briefing.morning', sent: 1, held: 0, digested: 0, dropped: 0 },
    ]);
  });
});

describe('QuietHoursNotifier stats', () => {
  it('records sent, held, digested and dropped without counting a later flush twice', async () => {
    const clock = new FakeClock(at('23:00'));
    const channel = new FakeOwnerChannel();
    const notifier = new QuietHoursNotifier({
      channel: () => channel,
      clock,
      timeZone: 'Asia/Seoul',
      quietHours: QUIET_22_07,
      kv: new MapKeyValueStore(),
      log: silentLogger,
      dailyBudget: 2,
    });

    await notifier.mute('chat.replies');
    expect(await notifier.notify({ kind: 'briefing.morning', text: '밤 하나' })).toBe('held');
    expect(await notifier.notify({ kind: 'chat.replies', text: '꺼진 소식' })).toBe('dropped');
    expect(await notifier.notify({ kind: 'todo.reminder', text: '밤 둘' })).toBe('held');
    expect(await notifier.notify({ kind: 'watch.price', text: '넘침' })).toBe('held');

    await clock.advance(8 * HOUR_MS);
    expect(channel.sent.map((message) => message.text)).toEqual(['밤 하나', '밤 둘']);

    const week = await notifier.stats.week(at('08:00', 18));
    expect(week).toEqual([
      { kind: 'briefing.morning', sent: 0, held: 1, digested: 0, dropped: 0 },
      { kind: 'chat.replies', sent: 0, held: 0, digested: 0, dropped: 1 },
      { kind: 'todo.reminder', sent: 0, held: 1, digested: 0, dropped: 0 },
      { kind: 'watch.price', sent: 0, held: 0, digested: 1, dropped: 0 },
    ]);
    expect(await notifier.stats.overBudgetDays(at('08:00', 18), 7)).toBe(1);
  });
});
