import type { LiveBrowser, LiveFrame, LiveKey } from '../../core/contracts/index.js';

/** A phone-sized page drawn at twice the CSS pixels, so the picture stays sharp on an iPhone. */
export const LIVE_VIEWPORT = { width: 412, height: 860 } as const;
export const LIVE_SCALE = 2;
const JPEG_QUALITY = 60;
const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 5_000;

/** The slice of a Playwright Page the live session uses; tests pass a fake. */
export interface LivePage {
  goto(url: string, options: { timeout: number; waitUntil: 'domcontentloaded' }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  screenshot(options: { type: 'jpeg'; quality: number; scale: 'device'; timeout: number }): Promise<Buffer>;
  mouse: { click(x: number, y: number): Promise<void>; wheel(dx: number, dy: number): Promise<void> };
  keyboard: { type(text: string): Promise<void>; press(key: string): Promise<void> };
  goBack(options: { timeout: number }): Promise<unknown>;
  close(): Promise<void>;
  isClosed?(): boolean;
  on?(event: 'close', listener: () => void): unknown;
  /** Present on a real page: a run's page taken over is resized to the phone screen. */
  setViewportSize?(size: { width: number; height: number }): Promise<void>;
  /** Present on a real page: lifts the run's off-site block, so the owner's own login may go through another site. */
  unroute?(pattern: string): Promise<void>;
}

export interface LiveContext {
  newPage(): Promise<LivePage>;
  close(): Promise<void>;
  /** A link that opens a new tab: the live view follows it. */
  on?(event: 'page', listener: (page: LivePage) => void): unknown;
}

export interface LiveLaunchOptions {
  headless: boolean;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
}

export const LIVE_LAUNCH: LiveLaunchOptions = { headless: true, viewport: { ...LIVE_VIEWPORT }, deviceScaleFactor: LIVE_SCALE };

/**
 * One page of the persistent profile, driven by the owner's taps from the app. Nothing here logs what is typed; the
 * profile is freed (`release`) exactly once, however the session ends.
 */
export class PlaywrightLive implements LiveBrowser {
  private readonly pages: LivePage[];
  private closed = false;

  constructor(
    private readonly context: LiveContext,
    first: LivePage,
    private readonly release: () => void,
  ) {
    this.pages = [first];
    context.on?.('page', (page) => {
      this.pages.push(page);
      page.on?.('close', () => {
        const index = this.pages.indexOf(page);
        if (index > 0) this.pages.splice(index, 1);
      });
    });
  }

  private page(): LivePage {
    if (this.closed) throw new Error('The live browser is closed.');
    for (let index = this.pages.length - 1; index >= 0; index -= 1) {
      const page = this.pages[index];
      if (page !== undefined && page.isClosed?.() !== true) return page;
    }
    throw new Error('The live page was closed.');
  }

  async frame(): Promise<LiveFrame> {
    const page = this.page();
    const jpeg = await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, scale: 'device', timeout: ACTION_TIMEOUT_MS });
    return {
      jpeg,
      width: LIVE_VIEWPORT.width * LIVE_SCALE,
      height: LIVE_VIEWPORT.height * LIVE_SCALE,
      url: page.url(),
      title: await page.title().catch(() => ''),
    };
  }

  async tap(x: number, y: number): Promise<void> {
    await this.page().mouse.click(x / LIVE_SCALE, y / LIVE_SCALE);
  }

  async type(text: string): Promise<void> {
    await this.page().keyboard.type(text);
  }

  async key(name: LiveKey): Promise<void> {
    await this.page().keyboard.press(name);
  }

  async scroll(dy: number): Promise<void> {
    await this.page().mouse.wheel(0, dy / LIVE_SCALE);
  }

  async back(): Promise<void> {
    await this.page().goBack({ timeout: NAVIGATION_TIMEOUT_MS }).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.context.close();
    } catch {
      // the profile is freed either way
    } finally {
      this.release();
    }
  }
}

/**
 * Takes over a run's page a handoff kept open (same profile, drawn at `LIVE_SCALE`): the run's off-site block is
 * lifted and the page is fitted to the phone screen, keeping whatever was already filled in.
 */
export async function adoptLivePage(context: LiveContext, page: LivePage, release: () => void): Promise<PlaywrightLive> {
  await page.unroute?.('**/*').catch(() => undefined);
  await page.setViewportSize?.({ ...LIVE_VIEWPORT }).catch(() => undefined);
  return new PlaywrightLive(context, page, release);
}

/** Opens the live page; on any failure the context is closed and the profile freed before the error is thrown. */
export async function openLivePage(context: LiveContext, url: string, release: () => void): Promise<PlaywrightLive> {
  try {
    const page = await context.newPage();
    await page.goto(url, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
    return new PlaywrightLive(context, page, release);
  } catch (error) {
    await context.close().catch(() => undefined);
    release();
    throw error;
  }
}
