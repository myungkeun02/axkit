import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PlaywrightAgent,
  type PlaywrightAgentOptions,
} from '../../../src/connectors/browser/playwright-agent.js';
import { flush } from '../../core/helpers.js';
import { fakePlaywright } from './helpers.js';
import type { FakePlaywright } from './helpers.js';

const PROFILE = '/tmp/ax-kit-browser-profile-test';
const INSTALL_MESSAGE =
  'Playwright is not installed: run `pnpm add playwright && npx playwright install chromium` in the ax-kit folder';

function agentWith(fake: FakePlaywright, overrides: Partial<PlaywrightAgentOptions> = {}): PlaywrightAgent {
  return new PlaywrightAgent({
    profileDir: PROFILE,
    load: fake.load,
    prepareProfile: async () => undefined,
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PlaywrightAgent', () => {
  it('reads a page and caps the text at 20000 characters', async () => {
    const fake = fakePlaywright({ title: '예시 상점', text: 'x'.repeat(25_000) });

    const result = await agentWith(fake).read('https://example.com/item');

    expect(result.status).toBe('done');
    expect(result.url).toBe('https://example.com/item');
    expect(result.summary.startsWith('예시 상점\n')).toBe(true);
    expect(result.summary.slice('예시 상점\n'.length)).toHaveLength(20_000);
    expect(fake.launches[0]?.dir).toBe(PROFILE);
    expect(fake.launches[0]?.options.headless).toBe(true);
    expect(fake.launches[0]?.context.pages[0]?.lastGoto).toEqual({ timeout: 30_000, waitUntil: 'domcontentloaded' });
  });

  it('closes the page and the context after reading', async () => {
    const fake = fakePlaywright();
    await agentWith(fake).read('https://example.com/');
    const launch = fake.launches[0];
    expect(launch?.context.closed).toBe(true);
    expect(launch?.context.pages[0]?.closed).toBe(true);
  });

  it('stops with needs_human on a login screen', async () => {
    const fake = fakePlaywright({ title: 'Sign in', text: '로그인 후 이용해 주세요' });

    const result = await agentWith(fake).read('https://example.com/login');

    expect(result.status).toBe('needs_human');
    expect(result.handoff).toEqual({ reason: 'login', url: 'https://example.com/login' });
  });

  it('stops on a checkout path even when the text looks ordinary', async () => {
    const fake = fakePlaywright({ text: '주문 내용' });
    const result = await agentWith(fake).read('https://example.com/checkout');
    expect(result.handoff?.reason).toBe('payment');
  });

  it('reports the install command when the optional package is missing', async () => {
    const agent = new PlaywrightAgent({
      profileDir: PROFILE,
      load: async () => {
        throw new Error('Cannot find module playwright');
      },
    });

    const result = await agent.read('https://example.com/');

    expect(result).toEqual({ status: 'failed', summary: INSTALL_MESSAGE });
  });

  it('refuses non-http addresses before loading anything', async () => {
    const fake = fakePlaywright();
    const result = await agentWith(fake).read('javascript:alert(1)');
    expect(result.status).toBe('failed');
    expect(fake.launches).toHaveLength(0);
  });

  it('needs a start address for a task', async () => {
    const fake = fakePlaywright();
    const result = await agentWith(fake).run({ goal: 'Find the price' });
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('needs a start address');
    expect(fake.launches).toHaveLength(0);
  });

  it('echoes the goal when a start address is given', async () => {
    const fake = fakePlaywright({ text: '가격 12,900원' });

    const result = await agentWith(fake).run({ goal: 'Find the price', startUrl: 'https://example.com/item' });

    expect(result.status).toBe('done');
    expect(result.summary).toContain('가격 12,900원');
    expect(result.summary).toContain('Goal: Find the price');
  });

  it('opens a headed window on the same profile and closes it after the timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fake = fakePlaywright();
    const agent = agentWith(fake);

    const opening = agent.openForHuman('https://example.com/login');
    await flush();
    expect(fake.launches[0]?.options.headless).toBe(false);
    expect(fake.launches[0]?.dir).toBe(PROFILE);

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await opening;

    expect(fake.launches[0]?.context.closed).toBe(true);
  });

  it('resolves openForHuman when the owner closes the window', async () => {
    const fake = fakePlaywright();
    const agent = agentWith(fake);

    const opening = agent.openForHuman('https://example.com/login');
    await flush();
    const context = fake.launches[0]?.context;
    await context?.pages[0]?.close();
    await opening;

    expect(context?.closed).toBe(true);
  });
  describe('a page read without a model keeps its handoff page when asked', () => {
    const LOGIN = { title: 'Sign in', text: '로그인 후 이용해 주세요' };
    function manualTimers(): { setTimeout: (fn: () => void) => unknown; clearTimeout: (h: unknown) => void; fire(): void } {
      const timers = new Map<number, () => void>();
      let next = 0;
      return {
        setTimeout: (fn) => (timers.set(++next, fn), next),
        clearTimeout: (handle) => void timers.delete(handle as number),
        fire: () => {
          for (const [id, fn] of [...timers]) {
            timers.delete(id);
            fn();
          }
        },
      };
    }

    it('keeps the page at the live scale and hands it to the live view as it is', async () => {
      const fake = fakePlaywright(LOGIN);
      const agent = agentWith(fake);
      const result = await agent.run({ goal: '로그인', startUrl: 'https://example.com/login', keepPage: true });
      expect(result).toMatchObject({ status: 'needs_human', handoff: { reason: 'login' } });
      const launch = fake.launches[0];
      expect(launch?.options).toMatchObject({ headless: true, deviceScaleFactor: 2 });
      expect(launch?.context.closed).toBe(false);
      expect(launch?.context.pages[0]?.closed).toBe(false);

      const live = await agent.openLive('https://example.com/login');
      expect(fake.launches).toHaveLength(1);
      // the live view holds the profile now: a read waits its turn
      expect((await agent.read('https://example.com/')).summary).toContain("owner's app");
      await live.close();
      expect(launch?.context.closed).toBe(true);
      expect((await agent.read('https://example.com/')).status).toBe('needs_human');
    });

    it('closes the kept page when another errand needs the profile or the keep window runs out', async () => {
      const fake = fakePlaywright(LOGIN);
      const timers = manualTimers();
      const agent = agentWith(fake, { keepTimers: timers });
      await agent.run({ goal: '로그인', startUrl: 'https://example.com/login', keepPage: true });
      await agent.read('https://example.com/other');
      expect(fake.launches[0]?.context.closed).toBe(true);
      expect(fake.launches).toHaveLength(2);

      await agent.run({ goal: '로그인', startUrl: 'https://example.com/login', keepPage: true });
      expect(fake.launches[2]?.context.closed).toBe(false);
      timers.fire();
      await flush();
      expect(fake.launches[2]?.context.closed).toBe(true);
      // the profile is free again: the live view opens the address anew
      await (await agent.openLive('https://example.com/login')).close();
      expect(fake.launches).toHaveLength(4);
    });

    it('closes as before without keepPage, or when the page needs no one', async () => {
      const fake = fakePlaywright(LOGIN);
      await agentWith(fake).run({ goal: '로그인', startUrl: 'https://example.com/login' });
      expect(fake.launches[0]?.context.closed).toBe(true);
      expect(fake.launches[0]?.options).toEqual({ headless: true });
      const plain = fakePlaywright({ text: '가격 12,900원' });
      await agentWith(plain).run({ goal: '가격', startUrl: 'https://example.com/item', keepPage: true });
      expect(plain.launches[0]?.context.closed).toBe(true);
    });
  });
});
