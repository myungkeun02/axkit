import { describe, expect, it } from 'vitest';
import type { OwnerChannel, OwnerSendOptions } from '../../../src/core/contracts/notify.js';
import type { LiveHandoff, OutgoingMessage } from '../../../src/core/conversation/types.js';
import { QuietHoursNotifier } from '../../../src/core/notify/quiet-notifier.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { FakeClock, MapKeyValueStore } from '../helpers.js';

const MINUTE_MS = 60_000;

class Channel implements OwnerChannel {
  readonly sent: OutgoingMessage[] = [];
  readonly options: (OwnerSendOptions | undefined)[] = [];
  fail = false;
  async send(message: OutgoingMessage, options?: OwnerSendOptions): Promise<void> {
    if (this.fail) throw new Error('down');
    this.sent.push(message);
    this.options.push(options);
  }
}

function at(hhmm: string): Date {
  return new Date(`2026-11-17T${hhmm}:00+09:00`);
}

function make(clock: FakeClock, channel: Channel, cap?: number): QuietHoursNotifier {
  return new QuietHoursNotifier({
    channel: () => channel,
    clock,
    timeZone: 'Asia/Seoul',
    quietHours: { from: '22:00', to: '07:00' },
    kv: new MapKeyValueStore(),
    log: silentLogger,
    dailyBudget: 0,
    ...(cap !== undefined ? { perKindHourlyCap: cap } : {}),
  });
}

const live: LiveHandoff = { view: 'browser-live', reason: 'login', url: 'https://example.com' };
const choices = [{ id: 'browser.takeover', label: '직접 할게요' }];
const images = [{ url: 'https://example.com/shot.png' }];

describe('notices keep every message field', () => {
  it('forwards live, images and choices when sent right away', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new Channel();
    const notifier = make(clock, channel);
    await notifier.notify({ kind: 'work.browser', text: '로그인이 필요해요', choices, live, images });
    expect(channel.sent).toEqual([{ text: '로그인이 필요해요', choices, live, images }]);
  });

  it('keeps live on a notice held for quiet hours', async () => {
    const clock = new FakeClock(at('23:00'));
    const channel = new Channel();
    const notifier = make(clock, channel);
    expect(await notifier.notify({ kind: 'work.errand', text: '결제 직전이에요', live })).toBe('held');
    await clock.advance(9 * 60 * MINUTE_MS);
    expect(channel.sent).toEqual([{ text: '결제 직전이에요', live }]);
  });

  it('keeps live on a notice retried after a failed send', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new Channel();
    const notifier = make(clock, channel);
    channel.fail = true;
    expect(await notifier.notify({ kind: 'work.browser', text: '이어서 해 주세요', live })).toBe('held');
    channel.fail = false;
    await clock.advance(2 * MINUTE_MS);
    expect(channel.sent).toEqual([{ text: '이어서 해 주세요', live }]);
  });
});

describe('over-cap interactive notices', () => {
  it('waits out the cap window and is sent with its buttons, not folded into the digest', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new Channel();
    const notifier = make(clock, channel, 1);
    expect(await notifier.notify({ kind: 'work.browser', text: '첫 번째' })).toBe('sent');
    await clock.advance(10 * MINUTE_MS);
    expect(await notifier.notify({ kind: 'work.browser', text: '이걸로 할까요?', choices, live })).toBe('held');
    expect(channel.sent).toHaveLength(1);
    expect(await notifier.flushDigest()).toBe('empty');

    await clock.advance(50 * MINUTE_MS);
    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[1]).toEqual({ text: '이걸로 할까요?', choices, live });
  });

  it('still folds plain over-cap notices into the digest', async () => {
    const clock = new FakeClock(at('09:00'));
    const channel = new Channel();
    const notifier = make(clock, channel, 1);
    await notifier.notify({ kind: 'watch.price', text: '하나' });
    expect(await notifier.notify({ kind: 'watch.price', text: '둘' })).toBe('held');
    expect(await notifier.flushDigest()).toBe('sent');
    expect(channel.sent.at(-1)?.text).toContain('둘');
    expect(channel.options.map((options) => options?.kind)).toEqual(['watch.price', 'digest']);
  });

  it('names the overnight fold "overnight" on the wire', async () => {
    const clock = new FakeClock(at('23:00'));
    const channel = new Channel();
    const notifier = make(clock, channel);
    for (const text of ['하나', '둘', '셋']) await notifier.notify({ kind: 'watch.price', text });
    await clock.advance(9 * 60 * MINUTE_MS);
    expect(channel.options.map((options) => options?.kind)).toEqual(['overnight']);
  });
});
