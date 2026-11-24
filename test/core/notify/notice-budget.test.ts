import { describe, expect, it } from 'vitest';
import type { OutgoingMessage } from '../../../src/core/conversation/types.js';
import type { OwnerChannel } from '../../../src/core/contracts/notify.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { QuietHoursNotifier } from '../../../src/core/notify/quiet-notifier.js';
import type { QuietHours } from '../../../src/core/notify/quiet-window.js';
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

interface Options {
  clock: FakeClock;
  kv: MapKeyValueStore;
  channel: OwnerChannel;
  quietHours?: QuietHours;
  dailyBudget?: number;
  cap?: number;
  digestTitle?: (count: number) => string;
}

function make(opts: Options): QuietHoursNotifier {
  return new QuietHoursNotifier({
    channel: () => opts.channel,
    clock: opts.clock,
    timeZone: 'Asia/Seoul',
    kv: opts.kv,
    log: silentLogger,
    ...(opts.quietHours !== undefined ? { quietHours: opts.quietHours } : {}),
    ...(opts.dailyBudget !== undefined ? { dailyBudget: opts.dailyBudget } : {}),
    ...(opts.cap !== undefined ? { perKindHourlyCap: opts.cap } : {}),
    ...(opts.digestTitle !== undefined ? { digestTitle: opts.digestTitle } : {}),
  });
}

describe('QuietHoursNotifier daily budget', () => {
  it('never folds a card with buttons into the digest', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv: new MapKeyValueStore(), channel, dailyBudget: 1 });

    expect(await notifier.notify({ kind: 'todo.reminder', text: '하나' })).toBe('sent');
    const card = { kind: 'company.decision', text: '결재', choices: [{ id: 'company.approve:abcd1234', label: '승인' }] };
    expect(await notifier.notify(card)).toBe('sent');
    expect(channel.sent[1]?.choices).toHaveLength(1);
  });

  it('holds notices over the budget in the digest instead of sending them', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv: new MapKeyValueStore(), channel, dailyBudget: 2 });

    expect(await notifier.notify({ kind: 'briefing.morning', text: '하나' })).toBe('sent');
    expect(await notifier.notify({ kind: 'todo.reminder', text: '둘' })).toBe('sent');
    expect(await notifier.notify({ kind: 'watch.price', text: '셋' })).toBe('held');
    expect(channel.sent.map((message) => message.text)).toEqual(['하나', '둘']);

    expect(await notifier.flushDigest()).toBe('sent');
    expect(channel.sent[2]).toEqual({ text: 'Notices folded into one (1)\n- 셋' });
    expect(await notifier.flushDigest()).toBe('empty');
  });

  it('lets urgent notices through and never digests or counts them', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv: new MapKeyValueStore(), channel, dailyBudget: 1 });

    expect(await notifier.notify({ kind: 'todo.reminder', text: '보통' })).toBe('sent');
    expect(await notifier.notify({ kind: 'reminder', text: '급해요', urgent: true })).toBe('sent');
    expect(await notifier.notify({ kind: 'watch.price', text: '넘침' })).toBe('held');

    await notifier.flushDigest();
    expect(channel.sent.map((message) => message.text)).toEqual([
      '보통',
      '급해요',
      'Notices folded into one (1)\n- 넘침',
    ]);
  });

  it('sends one digest message with clipped first lines and a remaining count', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv: new MapKeyValueStore(), channel, dailyBudget: 1, cap: 100 });
    await notifier.notify({ kind: 'briefing.morning', text: '첫 소식' });

    await notifier.notify({
      kind: 'watch.price',
      text: `${'x'.repeat(150)}\n둘째 줄`,
    });
    for (let index = 1; index < 17; index += 1) {
      await notifier.notify({ kind: 'watch.price', text: `줄 ${index}` });
    }

    expect(await notifier.flushDigest()).toBe('sent');
    const message = channel.sent[1];
    expect(message).toBeDefined();
    const lines = (message?.text ?? '').split('\n');
    expect(message?.choices).toBeUndefined();
    expect(lines).toHaveLength(17);
    expect(lines[0]).toBe('Notices folded into one (17)');
    expect(lines[1]).toBe(`- ${'x'.repeat(120)}`);
    expect(lines[2]).toBe('- 줄 1');
    expect(lines[16]).toBe('… +2');
  });

  it('uses the owner-language digest title', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({
      clock,
      kv: new MapKeyValueStore(),
      channel,
      dailyBudget: 1,
      digestTitle: (count) => `알림 ${count}개를 하나로 모았어요`,
    });

    await notifier.notify({ kind: 'briefing.morning', text: '하나' });
    await notifier.notify({ kind: 'todo.reminder', text: '둘' });
    await notifier.flushDigest();

    expect(channel.sent[1]?.text).toBe('알림 1개를 하나로 모았어요\n- 둘');
  });

  it('keeps the budget across a restart', async () => {
    const kv = new MapKeyValueStore();
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();

    expect(await make({ clock, kv, channel, dailyBudget: 1 }).notify({
      kind: 'briefing.morning',
      text: '아침',
    })).toBe('sent');
    expect(await make({ clock, kv, channel, dailyBudget: 1 }).notify({
      kind: 'todo.reminder',
      text: '저녁',
    })).toBe('held');
    expect(channel.sent).toHaveLength(1);
  });

  it('keeps the hourly per-kind cap across a restart', async () => {
    const kv = new MapKeyValueStore();
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();
    const notice = { kind: 'watch.price', text: '가격 변동' };
    const options = { clock, kv, channel, cap: 1, dailyBudget: 0 };

    expect(await make(options).notify(notice)).toBe('sent');
    // over the cap: folded into the next digest, not sent now
    expect(await make(options).notify(notice)).toBe('held');

    await clock.advance(61 * 60_000);
    expect(await make(options).notify(notice)).toBe('sent');
    expect(channel.sent).toHaveLength(2);
  });

  it('leaves the digest queued during quiet hours', async () => {
    const clock = new FakeClock(at('23:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({
      clock,
      kv: new MapKeyValueStore(),
      channel,
      quietHours: QUIET_22_07,
      dailyBudget: 1,
    });

    expect(await notifier.notify({ kind: 'briefing.morning', text: '밤 소식' })).toBe('held');
    expect(await notifier.notify({ kind: 'watch.price', text: '넘친 소식' })).toBe('held');
    expect(await notifier.flushDigest()).toBe('held');
    expect(channel.sent).toHaveLength(0);

    await clock.advance(8 * HOUR_MS);
    expect(await notifier.flushDigest()).toBe('sent');
    expect(channel.sent.map((message) => message.text)).toEqual([
      '밤 소식',
      'Notices folded into one (1)\n- 넘친 소식',
    ]);
  });

  it('drops a repeat of a digested notice when it carries a dedupe key', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new FakeOwnerChannel();
    const notifier = make({ clock, kv: new MapKeyValueStore(), channel, dailyBudget: 1 });
    const notice = { kind: 'watch.price', text: '같은 소식', dedupeKey: 'item-1' };

    expect(await notifier.notify({ kind: 'briefing.morning', text: '하나' })).toBe('sent');
    expect(await notifier.notify(notice)).toBe('held');
    expect(await notifier.notify(notice)).toBe('dropped');
  });
});
