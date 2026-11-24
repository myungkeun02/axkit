import { describe, expect, it } from 'vitest';
import type { DiscordInbound } from '../../../src/channels/discord/port.js';
import { newPairingCode, waitForOwnerPairing } from '../../../src/channels/discord/pairing.js';
import { flush } from '../../core/helpers.js';
import { FakeDiscordPort } from './fake-port.js';

function timerHarness() {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    timers,
    setTimer(fn: () => void): unknown {
      next += 1;
      timers.set(next, fn);
      return next;
    },
    clearTimer(handle: unknown): void {
      if (typeof handle === 'number') timers.delete(handle);
    },
    async fire(): Promise<void> {
      const due = [...timers.values()];
      timers.clear();
      for (const fn of due) fn();
      await settle();
    },
  };
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) await flush();
}

function message(overrides: Partial<DiscordInbound> = {}): DiscordInbound {
  return {
    id: 'in-1',
    channelId: 'dm-user-1',
    authorId: 'user-1',
    authorIsBot: false,
    isDm: true,
    content: '123456',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function start(port: FakeDiscordPort, overrides: Partial<Parameters<typeof waitForOwnerPairing>[0]> = {}) {
  const timers = timerHarness();
  const promise = waitForOwnerPairing({
    port,
    token: 'bot-token',
    code: '123456',
    language: 'ko',
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...overrides,
  });
  // Rejections are asserted later in the test; keep Node from reporting them as unhandled in between.
  void promise.catch(() => undefined);
  return { promise, timers };
}

describe('newPairingCode', () => {
  it('zero pads a random integer to six digits', () => {
    expect(newPairingCode(() => 0)).toBe('000000');
    expect(newPairingCode(() => 42)).toBe('000042');
    expect(newPairingCode(() => 999999)).toBe('999999');
  });

  it('draws six digits from the default random source', () => {
    for (let index = 0; index < 20; index += 1) {
      expect(newPairingCode()).toMatch(/^\d{6}$/);
    }
  });
});

describe('waitForOwnerPairing', () => {
  it('resolves with the author of the DM that sends the code', async () => {
    const port = new FakeDiscordPort();
    const { promise, timers } = start(port);
    await settle();

    expect(port.logins).toEqual(['bot-token']);
    port.emitMessage(message({ content: ' 123456 ' }));
    await expect(promise).resolves.toEqual({ userId: 'user-1' });

    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]?.channelId).toBe('dm-user-1');
    expect(port.sent[0]?.payload.content).toBe('연결됐어요. 이제 당신의 메시지만 지시로 받아요.');
    expect(port.destroyed).toBe(true);
    expect(timers.timers.size).toBe(0);
  });

  it('ignores the correct code outside a DM', async () => {
    const port = new FakeDiscordPort();
    const { promise } = start(port);
    await settle();
    let settled = false;
    void promise.finally(() => {
      settled = true;
    });

    port.emitMessage(message({ isDm: false, channelId: 'guild-1' }));
    await settle();
    expect(settled).toBe(false);
    expect(port.sent).toHaveLength(0);

    port.emitMessage(message());
    await expect(promise).resolves.toEqual({ userId: 'user-1' });
  });

  it('ignores bot messages', async () => {
    const port = new FakeDiscordPort();
    const { promise } = start(port);
    await settle();
    let settled = false;
    void promise.finally(() => {
      settled = true;
    });

    port.emitMessage(message({ authorIsBot: true }));
    await settle();
    expect(settled).toBe(false);
    expect(port.sent).toHaveLength(0);

    port.emitMessage(message());
    await expect(promise).resolves.toEqual({ userId: 'user-1' });
  });

  it('answers a wrong six-digit code and rejects after the attempt limit', async () => {
    const port = new FakeDiscordPort();
    const { promise } = start(port, { maxAttempts: 3 });
    await settle();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      port.emitMessage(message({ id: `in-${attempt}`, content: '000000' }));
      await settle();
    }

    await expect(promise).rejects.toThrow('too many wrong codes');
    expect(port.sent.map((sent) => sent.payload.content)).toEqual([
      '코드가 맞지 않아요. 터미널에 표시된 6자리 코드를 다시 보내 주세요.',
      '코드가 맞지 않아요. 터미널에 표시된 6자리 코드를 다시 보내 주세요.',
      '코드가 맞지 않아요. 터미널에 표시된 6자리 코드를 다시 보내 주세요.',
    ]);
    expect(port.destroyed).toBe(true);
  });

  it('still pairs after some wrong codes', async () => {
    const port = new FakeDiscordPort();
    const { promise } = start(port, { maxAttempts: 3 });
    await settle();

    port.emitMessage(message({ id: 'in-1', content: '000000' }));
    port.emitMessage(message({ id: 'in-2', content: '111111' }));
    await settle();
    port.emitMessage(message({ id: 'in-3', content: '123456' }));

    await expect(promise).resolves.toEqual({ userId: 'user-1' });
    expect(port.sent.at(-1)?.payload.content).toBe('연결됐어요. 이제 당신의 메시지만 지시로 받아요.');
    expect(port.destroyed).toBe(true);
  });

  it('hints at the code for other text without counting it', async () => {
    const port = new FakeDiscordPort();
    const { promise } = start(port, { maxAttempts: 2 });
    await settle();

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      port.emitMessage(message({ id: `in-${attempt}`, content: 'hello' }));
      await settle();
    }

    expect(port.sent).toHaveLength(3);
    for (const sent of port.sent) {
      expect(sent.payload.content).toBe('터미널에 표시된 6자리 숫자 코드를 이 대화로 보내 주세요.');
    }

    port.emitMessage(message({ id: 'in-4' }));
    await expect(promise).resolves.toEqual({ userId: 'user-1' });
  });

  it('rejects and destroys the port when the code expires', async () => {
    const port = new FakeDiscordPort();
    const { promise, timers } = start(port, { expiresMs: 60_000 });
    await settle();

    expect([...timers.timers.values()]).toHaveLength(1);
    await timers.fire();

    await expect(promise).rejects.toThrow('pairing code expired');
    expect(port.destroyed).toBe(true);
    expect(timers.timers.size).toBe(0);
  });
});
