import { describe, expect, it } from 'vitest';
import { LIVE_SCALE, LIVE_VIEWPORT } from '../../../src/connectors/browser/live.js';
import type { LiveContext, LivePage } from '../../../src/connectors/browser/live.js';
import { PlaywrightAgent } from '../../../src/connectors/browser/playwright-agent.js';
import type { PlaywrightLike } from '../../../src/connectors/browser/playwright-agent.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

class FakeLivePage implements LivePage {
  readonly calls: string[] = [];
  typed: string[] = [];
  current = '';
  closed = false;
  failGoto = false;
  readonly mouse = {
    click: async (x: number, y: number) => {
      this.calls.push(`click ${x},${y}`);
    },
    wheel: async (dx: number, dy: number) => {
      this.calls.push(`wheel ${dx},${dy}`);
    },
  };
  readonly keyboard = {
    type: async (text: string) => {
      this.typed.push(text);
    },
    press: async (key: string) => {
      this.calls.push(`press ${key}`);
    },
  };
  async goto(url: string): Promise<void> {
    if (this.failGoto) throw new Error('net::ERR_NAME_NOT_RESOLVED');
    this.current = url;
  }
  url(): string {
    return this.current;
  }
  async title(): Promise<string> {
    return '로그인';
  }
  async screenshot(options: { type: 'jpeg'; quality: number; scale: 'device' }): Promise<Buffer> {
    this.calls.push(`shot ${options.type} ${options.scale}`);
    return JPEG;
  }
  async goBack(): Promise<void> {
    this.calls.push('back');
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  isClosed(): boolean {
    return this.closed;
  }
}

interface Launched {
  options: unknown;
  context: LiveContext & { closed: boolean; page: FakeLivePage; emitPage(page: FakeLivePage): void };
}

function fakeLive(failGoto = false): { launches: Launched[]; load: () => Promise<PlaywrightLike> } {
  const launches: Launched[] = [];
  return {
    launches,
    load: async () =>
      ({
        chromium: {
          async launchPersistentContext(_dir: string, options: unknown) {
            const page = new FakeLivePage();
            page.failGoto = failGoto;
            let onPage: ((page: LivePage) => void) | undefined;
            const context = {
              closed: false,
              page,
              async newPage() {
                return page;
              },
              async close() {
                context.closed = true;
              },
              on(_event: 'page', listener: (page: LivePage) => void) {
                onPage = listener;
                return context;
              },
              emitPage(next: FakeLivePage) {
                onPage?.(next);
              },
            };
            launches.push({ options, context });
            return context;
          },
        },
      }) as unknown as PlaywrightLike,
  };
}

function agentWith(fake: { load: () => Promise<PlaywrightLike> }): PlaywrightAgent {
  return new PlaywrightAgent({ profileDir: '/tmp/axkit-test-profile', load: fake.load, prepareProfile: async () => undefined });
}

describe('Playwright live page', () => {
  it('opens a headless phone-sized page in the same profile and maps frame pixels to the page', async () => {
    const fake = fakeLive();
    const live = await agentWith(fake).openLive('https://example.com/login');

    expect(fake.launches[0]?.options).toEqual({ headless: true, viewport: { ...LIVE_VIEWPORT }, deviceScaleFactor: LIVE_SCALE });
    const frame = await live.frame();
    expect(frame).toMatchObject({ width: LIVE_VIEWPORT.width * 2, height: LIVE_VIEWPORT.height * 2, url: 'https://example.com/login', title: '로그인' });
    expect(frame.jpeg.equals(JPEG)).toBe(true);

    await live.tap(200, 400);
    await live.scroll(600);
    await live.key('Enter');
    await live.type('비밀번호123');
    await live.back();
    const page = fake.launches[0]?.context.page;
    expect(page?.calls).toEqual(['shot jpeg device', 'click 100,200', 'wheel 0,300', 'press Enter', 'back']);
    expect(page?.typed).toEqual(['비밀번호123']);
  });

  it('holds the profile while open: runs, reads and a second live page wait until it closes', async () => {
    const fake = fakeLive();
    const agent = agentWith(fake);
    const live = await agent.openLive('https://example.com/');

    const read = await agent.read('https://example.com/');
    expect(read.status).toBe('failed');
    expect(read.summary).toContain("owner's app");
    await expect(agent.openLive('https://example.com/')).rejects.toThrow("owner's app");
    await expect(agent.openForHuman('https://example.com/')).rejects.toThrow("owner's app");

    await live.close();
    await live.close();
    expect(fake.launches[0]?.context.closed).toBe(true);
    const again = await agent.openLive('https://example.com/');
    await again.close();
    expect(fake.launches).toHaveLength(2);
  });

  it('frees the profile when the page cannot open, and refuses non-http addresses', async () => {
    const fake = fakeLive(true);
    const agent = agentWith(fake);
    await expect(agent.openLive('https://nowhere.invalid/')).rejects.toThrow('ERR_NAME');
    expect(fake.launches[0]?.context.closed).toBe(true);
    await expect(agent.openLive('file:///etc/passwd')).rejects.toThrow('http');
    await expect(agent.openLive('https://nowhere.invalid/')).rejects.toThrow('ERR_NAME');
  });

  it('follows a link that opens a new tab, and comes back when that tab closes', async () => {
    const fake = fakeLive();
    const live = await agentWith(fake).openLive('https://example.com/');
    const popup = new FakeLivePage();
    popup.current = 'https://auth.example.com/';
    fake.launches[0]?.context.emitPage(popup);
    expect((await live.frame()).url).toBe('https://auth.example.com/');
    await popup.close();
    expect((await live.frame()).url).toBe('https://example.com/');
    await live.close();
    await expect(live.frame()).rejects.toThrow('closed');
  });
});
