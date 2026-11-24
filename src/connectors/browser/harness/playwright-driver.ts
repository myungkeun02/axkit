import { guardText } from '../../../core/text/data.js';
import { isHttpUrl } from '../url.js';
import { domainOf, inScope } from './policy.js';
import type { PolicyContext } from './policy.js';
import { parseAriaElements } from './snapshot.js';
import type { BrowserAction, Driver, Observation, PageElement } from './types.js';

const ACTION_TIMEOUT_MS = 5_000;
const SETTLE_TIMEOUT_MS = 5_000;
const MAX_TEXT_CHARS = 20_000;

/** The slice of a Playwright Page this driver uses; tests pass a fake. */
export interface HarnessPage {
  goto(url: string, options: { timeout: number; waitUntil: 'domcontentloaded' }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  innerText(selector: string): Promise<string>;
  goBack(options?: { timeout: number }): Promise<unknown>;
  waitForLoadState(state: 'domcontentloaded' | 'networkidle', options?: { timeout: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
  mouse: { wheel(dx: number, dy: number): Promise<void> };
  locator(selector: string): { ariaSnapshot(options?: { timeout: number }): Promise<string> };
  getByRole(
    role: string,
    options: { name: string; exact: boolean },
  ): {
    nth(index: number): {
      click(options: { timeout: number }): Promise<void>;
      fill(value: string, options: { timeout: number }): Promise<void>;
      selectOption(value: { label: string }, options: { timeout: number }): Promise<unknown>;
    };
  };
  close(): Promise<void>;
  /** Present on a real page: used to stop navigations to other sites before they load. */
  route?(
    pattern: string,
    handler: (route: {
      request(): { isNavigationRequest(): boolean; frame(): unknown; url(): string };
      fulfill(response: { status: number }): Promise<void>;
      continue(): Promise<void>;
    }) => Promise<void>,
  ): Promise<void>;
  mainFrame?(): unknown;
  /** Present on a real page: lifts the off-site block when the owner takes the page over. */
  unroute?(pattern: string): Promise<void>;
}

export interface HarnessContext {
  newPage(): Promise<HarnessPage>;
  close(): Promise<void>;
}

/** A run's page handed over open (a handoff kept for the owner's live view); the driver no longer owns it. */
export interface HeldPage {
  context: HarnessContext;
  page: HarnessPage;
}

export interface PlaywrightDriverOptions {
  open: () => Promise<HarnessContext>;
  policy: PolicyContext;
  navigationTimeoutMs?: number;
}

/**
 * Drives one Playwright page for the harness: observation = aria snapshot + visible text (screened for injection),
 * actions = role + exact name locators from that snapshot. Every navigation, including one a click caused, is checked
 * against the task's sites after it settles.
 */
export class PlaywrightDriver implements Driver {
  private context: HarnessContext | undefined;
  private page: HarnessPage | undefined;
  private readonly navigationTimeoutMs: number;
  /** The last off-site address the browser refused to open, reported back on the action that caused it. */
  private blocked: string | undefined;
  /** True while the start address loads: its own redirect to a new domain is allowed. */
  private opening = false;

  constructor(private readonly opts: PlaywrightDriverOptions) {
    this.navigationTimeoutMs = opts.navigationTimeoutMs ?? 30_000;
  }

  async start(url: string): Promise<void> {
    if (!isHttpUrl(url)) throw new Error('Only http and https addresses are supported.');
    this.context = await this.opts.open();
    this.page = await this.context.newPage();
    await this.blockOffSite(this.page);
    this.opening = true;
    try {
      await this.page.goto(url, { timeout: this.navigationTimeoutMs, waitUntil: 'domcontentloaded' });
    } finally {
      this.opening = false;
    }
  }

  async observe(): Promise<Observation> {
    const page = this.current();
    await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
    const url = page.url();
    const [title, text, snapshot] = await Promise.all([
      page.title().catch(() => ''),
      page.innerText('body').catch(() => ''),
      page.locator('body').ariaSnapshot({ timeout: SETTLE_TIMEOUT_MS }).catch(() => ''),
    ]);
    const elements = parseAriaElements(snapshot).map((element) => ({ ...element, name: guardText('browser.element', element.name) }));
    return {
      url,
      title: guardText('browser.title', title),
      text: guardText('browser.page', text.slice(0, MAX_TEXT_CHARS)),
      elements,
    };
  }

  async act(action: BrowserAction, element: PageElement | undefined): Promise<void> {
    const page = this.current();
    this.blocked = undefined;
    const target = (): ReturnType<ReturnType<HarnessPage['getByRole']>['nth']> => {
      if (element === undefined) throw new Error('no element for this action');
      return page.getByRole(element.role, { name: element.name, exact: true }).nth(element.nth);
    };
    switch (action.kind) {
      case 'click':
        await target().click({ timeout: ACTION_TIMEOUT_MS });
        break;
      case 'fill':
        await target().fill(action.text, { timeout: ACTION_TIMEOUT_MS });
        break;
      case 'select':
        await target().selectOption({ label: action.option }, { timeout: ACTION_TIMEOUT_MS });
        break;
      case 'press':
        await page.keyboard.press(action.key);
        break;
      case 'scroll':
        await page.mouse.wheel(0, action.direction === 'down' ? 700 : -700);
        break;
      case 'navigate':
        await page.goto(action.url, { timeout: this.navigationTimeoutMs, waitUntil: 'domcontentloaded' });
        break;
      case 'back':
        await page.goBack({ timeout: this.navigationTimeoutMs });
        break;
      case 'wait':
        await page.waitForTimeout(action.seconds * 1000);
        break;
    }
    await page.waitForLoadState('domcontentloaded', { timeout: SETTLE_TIMEOUT_MS }).catch(() => undefined);
    if (this.blocked !== undefined) {
      const host = new URL(this.blocked).hostname;
      this.blocked = undefined;
      throw new Error(`that link goes to ${host}, outside this task's sites; it was not opened`);
    }
    // a click or a redirect may have left the task's sites: go back instead of reading a page nobody asked for
    if (!inScope(page.url(), this.opts.policy)) {
      const left = page.url();
      await page.goBack({ timeout: this.navigationTimeoutMs }).catch(() => undefined);
      throw new Error(`that led outside this task's sites (${new URL(left).hostname}); went back`);
    }
  }

  /** A top-level navigation to another site is answered with 204 in the browser, so the page and its state stay as they were. */
  private async blockOffSite(page: HarnessPage): Promise<void> {
    if (page.route === undefined) return;
    await page.route('**/*', async (route) => {
      const request = route.request();
      const topLevel = request.isNavigationRequest() && (page.mainFrame === undefined || request.frame() === page.mainFrame());
      if (topLevel && !inScope(request.url(), this.opts.policy) && this.opening) {
        // the start address moving to the site's new home is the site itself, not a detour
        const domain = domainOf(new URL(request.url()).hostname);
        if (domain !== '' && !this.opts.policy.allowedDomains.includes(domain)) this.opts.policy.allowedDomains.push(domain);
      } else if (topLevel && !inScope(request.url(), this.opts.policy)) {
        this.blocked = request.url();
        // 204 No Content: the browser stays on the current page (an abort would show Chrome's error page)
        await route.fulfill({ status: 204 });
        return;
      }
      await route.continue();
    });
  }

  async close(): Promise<void> {
    await this.page?.close().catch(() => undefined);
    await this.context?.close().catch(() => undefined);
    this.page = undefined;
    this.context = undefined;
  }

  /** Hands the open page over instead of closing it; later `close` calls do nothing. */
  detach(): HeldPage | undefined {
    const { context, page } = this;
    this.page = undefined;
    this.context = undefined;
    return context !== undefined && page !== undefined ? { context, page } : undefined;
  }

  private current(): HarnessPage {
    if (this.page === undefined) throw new Error('The browser is not started.');
    return this.page;
  }
}
