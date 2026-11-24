import { describe, expect, it } from 'vitest';
import { KeptPages } from '../../../src/connectors/browser/kept.js';
import type { KeptPage, KeptTimers } from '../../../src/connectors/browser/kept.js';
import type { LiveContext, LivePage } from '../../../src/connectors/browser/live.js';

function kept(url: string): KeptPage & { closed: () => number; shut: () => void } {
  let closes = 0;
  let pageClosed = false;
  const page = { isClosed: () => pageClosed } as unknown as LivePage;
  const context = {
    newPage: async () => page,
    close: async () => {
      closes += 1;
    },
  } as LiveContext;
  return { context, page, url, closed: () => closes, shut: () => (pageClosed = true) };
}

function manualTimers(): KeptTimers & { fire(): void; pending(): number } {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    setTimeout: (fn) => {
      timers.set(++next, fn);
      return next;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
    fire: () => {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    pending: () => timers.size,
  };
}

describe('kept handoff pages', () => {
  it('hands the page over only for the same address, without closing it', async () => {
    let freed = 0;
    const timers = manualTimers();
    const pages = new KeptPages(() => (freed += 1), 1000, timers);
    const page = kept('https://shop.example.com/login');
    pages.hold(page);
    expect(pages.take('https://shop.example.com/other')).toBeUndefined();
    expect(pages.take('https://shop.example.com/login')).toBe(page);
    expect(timers.pending()).toBe(0);
    expect(pages.take('https://shop.example.com/login')).toBeUndefined();
    await pages.free();
    expect(page.closed()).toBe(0);
    expect(freed).toBe(0);
  });

  it('closes the page and frees the profile on timeout, once', async () => {
    let freed = 0;
    const timers = manualTimers();
    const pages = new KeptPages(() => (freed += 1), 1000, timers);
    const page = kept('https://shop.example.com/login');
    pages.hold(page);
    timers.fire();
    await Promise.all([pages.free(), pages.free()]);
    expect(page.closed()).toBe(1);
    expect(freed).toBe(1);
    expect(pages.take('https://shop.example.com/login')).toBeUndefined();
  });

  it('never hands over a page that was closed meanwhile', async () => {
    const pages = new KeptPages(() => undefined, 1000, manualTimers());
    const page = kept('https://shop.example.com/login');
    pages.hold(page);
    page.shut();
    expect(pages.take('https://shop.example.com/login')).toBeUndefined();
    await pages.free();
    expect(page.closed()).toBe(1);
  });
});
