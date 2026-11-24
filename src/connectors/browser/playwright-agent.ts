import { mkdir } from 'node:fs/promises';
import type { BrowserAgent, BrowserAuthHelper, BrowserRunResult, BrowserTask, LiveBrowser } from '../../core/contracts/index.js';
import { LIVE_LAUNCH, LIVE_SCALE, adoptLivePage, openLivePage } from './live.js';
import type { LiveContext, LiveLaunchOptions, LivePage } from './live.js';
import { KeptPages } from './kept.js';
import type { KeptTimers } from './kept.js';
import { detectCodeStep, detectHandoff } from './handoff.js';
import { isHttpUrl } from './url.js';
import { completeCodeStep } from './code-step.js';
import type { LlmGateway } from '../../core/llm/types.js';
import { runBrowserAgent } from './harness/agent-run.js';
import type { HarnessContext } from './harness/playwright-driver.js';
import type { HarnessLimits } from './harness/types.js';

const MAX_TEXT_CHARS = 20_000;
const OPEN_FOR_HUMAN_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_READ_TIMEOUT_MS = 30_000;
const INSTALL_MESSAGE =
  'Playwright is not installed: run `pnpm add playwright && npx playwright install chromium` in the ax-kit folder';

export interface PlaywrightPage {
  goto(url: string, options: { timeout: number; waitUntil: 'domcontentloaded' }): Promise<unknown>;
  title(): Promise<string>;
  innerText(selector: string): Promise<string>;
  url(): string;
  close(): Promise<void>;
  waitForEvent(event: 'close'): Promise<unknown>;
  /** Present on a real Playwright page; used only to type a one-time code on an owner-approved task. */
  $?(selector: string): Promise<unknown>;
  fill?(selector: string, value: string): Promise<void>;
  press?(selector: string, key: string): Promise<void>;
  waitForLoadState?(state: 'domcontentloaded', options?: { timeout: number }): Promise<void>;
}

const MAX_AUTH_ROUNDS = 2;
const MASK = '******';

export interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
  on(event: 'close', listener: () => void): unknown;
}

export interface PlaywrightBrowserType {
  launchPersistentContext(dir: string, options: { headless: boolean; deviceScaleFactor?: number } | LiveLaunchOptions): Promise<PlaywrightContext>;
}

export interface PlaywrightLike {
  chromium: PlaywrightBrowserType;
}

export interface PlaywrightAgentOptions {
  profileDir: string;
  headless?: boolean;
  readTimeoutMs?: number;
  /** Tests inject a fake; production loads the optional `playwright` package at run time. */
  load?: () => Promise<PlaywrightLike>;
  prepareProfile?: (dir: string) => Promise<void>;
  /** With a model, `run` drives the page step by step (the harness); without one it only reads the start page. */
  llm?: LlmGateway;
  limits?: Partial<HarnessLimits>;
  runsDir?: string;
  /** How long a handoff's page stays open for the live view (default 15 minutes); tests pass their own timers. */
  keepMs?: number;
  keepTimers?: KeptTimers;
}

function isPlaywrightLike(value: unknown): value is PlaywrightLike {
  if (typeof value !== 'object' || value === null) return false;
  const chromium = (value as { chromium?: unknown }).chromium;
  if (typeof chromium !== 'object' || chromium === null) return false;
  return typeof (chromium as { launchPersistentContext?: unknown }).launchPersistentContext === 'function';
}

async function defaultLoad(): Promise<PlaywrightLike> {
  const specifier = 'playwright';
  const mod: unknown = await import(specifier);
  if (!isPlaywrightLike(mod)) throw new Error('The playwright package has an unexpected shape.');
  return mod;
}

async function prepareProfileDefault(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Persistent Chromium profile: the owner's own logins stay on this Mac between runs. */
export class PlaywrightAgent implements BrowserAgent {
  readonly label = 'Playwright';
  private readonly profileDir: string;
  private readonly headless: boolean;
  private readonly readTimeoutMs: number;
  private readonly load: () => Promise<PlaywrightLike>;
  private readonly prepareProfile: (dir: string) => Promise<void>;
  private readonly llm: LlmGateway | undefined;
  private readonly limits: Partial<HarnessLimits> | undefined;
  private readonly runsDir: string | undefined;
  /**
   * One persistent profile can be open only once: runs, the owner's window and the live view take turns. `kept`: a
   * handoff's page waits for the live view; anything else that needs the profile closes it first.
   */
  private busy: 'run' | 'owner' | 'live' | 'kept' | undefined;
  private readonly kept: KeptPages;

  constructor(options: PlaywrightAgentOptions) {
    this.profileDir = options.profileDir;
    this.headless = options.headless ?? true;
    this.readTimeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.load = options.load ?? defaultLoad;
    this.prepareProfile = options.prepareProfile ?? prepareProfileDefault;
    this.llm = options.llm;
    this.limits = options.limits;
    this.runsDir = options.runsDir;
    const freed = (): void => {
      if (this.busy === 'kept') this.busy = undefined;
    };
    this.kept = new KeptPages(freed, options.keepMs, options.keepTimers);
  }

  async read(url: string, signal?: AbortSignal): Promise<BrowserRunResult> {
    await this.releaseKept();
    return this.busy !== undefined ? this.busyResult() : await this.openPage(url, undefined, signal);
  }

  /** Closes a handoff's page nobody took over, freeing the profile. */
  async releaseKept(): Promise<void> {
    if (this.busy === 'kept') await this.kept.free();
  }

  async run(task: BrowserTask, signal?: AbortSignal): Promise<BrowserRunResult> {
    if (task.startUrl === undefined) {
      return {
        status: 'failed',
        summary: 'The Playwright adapter needs a start address; a browser agent CLI can plan steps',
      };
    }
    // a new errand takes the profile back from a handoff's page the owner did not open
    await this.releaseKept();
    if (this.busy !== undefined) return this.busyResult();
    this.busy = 'run';
    const keep = task.keepPage === true;
    try {
      // without a model only the start page is read; a handoff there keeps its page the same way
      if (this.llm === undefined) return await this.openPage(task.startUrl, task.goal, signal, task.auth, keep);
      const llm = this.llm;
      return await runBrowserAgent({
        llm,
        // a page the live view may take over is drawn at its scale from the start
        open: () => this.openContext(this.headless, keep),
        ...(keep
          ? {
              keep: (held: { context: unknown; page: unknown; url: string }) => {
                this.busy = 'kept';
                this.kept.hold({ context: held.context as LiveContext, page: held.page as LivePage, url: held.url });
              },
            }
          : {}),
        goal: task.goal,
        startUrl: task.startUrl,
        ...(task.approvedCommit !== undefined ? { approvedCommit: task.approvedCommit } : {}),
        ...(this.limits !== undefined ? { limits: this.limits } : {}),
        ...(this.runsDir !== undefined ? { runsDir: this.runsDir } : {}),
        ...(signal !== undefined ? { signal } : {}),
      });
    } finally {
      if (this.busy === 'run') this.busy = undefined;
    }
  }

  private busyResult(): BrowserRunResult {
    return {
      status: 'failed',
      summary:
        this.busy === 'owner'
          ? 'The browser window is open for the owner; close it first, then try again.'
          : this.busy === 'live'
            ? "The browser is open in the owner's app; it frees up when the owner taps done (or after 15 idle minutes)."
            : 'Another browser task is running; try again when it finishes.',
    };
  }

  private async openContext(headless: boolean, forLive: boolean): Promise<HarnessContext> {
    const browser = await this.load();
    await this.prepareProfile(this.profileDir);
    const options = forLive ? { headless, deviceScaleFactor: LIVE_SCALE } : { headless };
    const context = await browser.chromium.launchPersistentContext(this.profileDir, options);
    return context as unknown as HarnessContext;
  }

  async openForHuman(url: string): Promise<void> {
    if (!isHttpUrl(url)) throw new Error('Only http and https addresses are supported.');
    await this.releaseKept();
    if (this.busy !== undefined) throw new Error(this.busyResult().summary);
    this.busy = 'owner';
    try {
      await this.showToOwner(url);
    } finally {
      this.busy = undefined;
    }
  }

  /**
   * A headless page in the same profile that the owner drives from the app; the profile stays taken until it closes.
   * The page a handoff kept for this address is taken over as it is; otherwise the address is opened again.
   */
  async openLive(url: string): Promise<LiveBrowser> {
    if (!isHttpUrl(url)) throw new Error('Only http and https addresses are supported.');
    const release = (): void => {
      if (this.busy === 'live') this.busy = undefined;
    };
    const kept = this.busy === 'kept' ? this.kept.take(url) : undefined;
    if (kept !== undefined) {
      this.busy = 'live';
      return await adoptLivePage(kept.context, kept.page, release);
    }
    await this.releaseKept();
    if (this.busy !== undefined) throw new Error(this.busyResult().summary);
    this.busy = 'live';
    let context: LiveContext;
    try {
      const browser = await this.load();
      await this.prepareProfile(this.profileDir);
      context = (await browser.chromium.launchPersistentContext(this.profileDir, LIVE_LAUNCH)) as unknown as LiveContext;
    } catch (error) {
      release();
      throw error;
    }
    return await openLivePage(context, url, release);
  }

  private async showToOwner(url: string): Promise<void> {
    const browser = await this.load();
    await this.prepareProfile(this.profileDir);
    const context = await browser.chromium.launchPersistentContext(this.profileDir, { headless: false });
    let page: PlaywrightPage | undefined;
    try {
      page = await context.newPage();
      await page.goto(url, { timeout: this.readTimeoutMs, waitUntil: 'domcontentloaded' });
      await this.waitForOwner(page, context);
    } finally {
      if (page !== undefined) await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
    }
  }

  private waitForOwner(page: PlaywrightPage, context: PlaywrightContext): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const state: { timer?: ReturnType<typeof setTimeout> } = {};
      const finish = (): void => {
        if (settled) return;
        settled = true;
        if (state.timer !== undefined) clearTimeout(state.timer);
        resolve();
      };
      state.timer = setTimeout(finish, OPEN_FOR_HUMAN_TIMEOUT_MS);
      context.on('close', finish);
      void page.waitForEvent('close').then(finish, finish);
    });
  }

  private async openPage(
    startUrl: string,
    goal: string | undefined,
    signal: AbortSignal | undefined,
    auth?: BrowserAuthHelper,
    keep = false,
  ): Promise<BrowserRunResult> {
    if (signal?.aborted === true) return { status: 'failed', summary: 'The run was cancelled.' };
    if (!isHttpUrl(startUrl)) {
      return { status: 'failed', summary: 'Only http and https addresses are supported.' };
    }

    let browser: PlaywrightLike;
    try {
      browser = await this.load();
    } catch {
      return { status: 'failed', summary: INSTALL_MESSAGE };
    }

    try {
      await this.prepareProfile(this.profileDir);
    } catch (error) {
      return { status: 'failed', summary: `Could not prepare the browser profile: ${messageOf(error)}` };
    }

    let context: PlaywrightContext;
    try {
      const options = keep ? { headless: this.headless, deviceScaleFactor: LIVE_SCALE } : { headless: this.headless };
      context = await browser.chromium.launchPersistentContext(this.profileDir, options);
    } catch (error) {
      return { status: 'failed', summary: `Could not start the browser: ${messageOf(error)}` };
    }

    let page: PlaywrightPage | undefined;
    let kept = false;
    try {
      page = await context.newPage();
      await page.goto(startUrl, { timeout: this.readTimeoutMs, waitUntil: 'domcontentloaded' });
      let body = await page.innerText('body').catch(() => '');
      const used: string[] = [];
      for (let round = 0; auth !== undefined && round < MAX_AUTH_ROUNDS; round += 1) {
        const before = detectHandoff(page.url(), body);
        if (before === 'payment' || before === 'captcha' || before === 'consent' || !detectCodeStep(body)) break;
        const code = await completeCodeStep(page, auth, body, signal, this.readTimeoutMs);
        if (code === undefined) break;
        if (code !== '') used.push(code);
        body = await page.innerText('body').catch(() => '');
      }
      const title = await page.title().catch(() => '');
      const pageUrl = page.url();
      // a code typed on the owner's behalf never reaches the model or a log through the page text
      const masked = used.reduce((acc, code) => acc.split(code).join(MASK), body);
      const text = masked.slice(0, MAX_TEXT_CHARS);
      const withGoal = goal === undefined ? text : `${text}\n\nGoal: ${goal}`;
      const summary = title === '' ? withGoal : `${title}\n${withGoal}`;
      const reason = detectHandoff(pageUrl, masked);
      if (reason !== undefined) {
        if (keep) {
          this.busy = 'kept';
          this.kept.hold({ context: context as unknown as LiveContext, page: page as unknown as LivePage, url: pageUrl });
          kept = true;
        }
        return { status: 'needs_human', summary, url: pageUrl, handoff: { reason, url: pageUrl } };
      }
      return { status: 'done', summary, url: pageUrl };
    } catch (error) {
      return { status: 'failed', summary: `Could not open the page: ${messageOf(error)}` };
    } finally {
      if (!kept) {
        if (page !== undefined) await page.close().catch(() => undefined);
        await context.close().catch(() => undefined);
      }
    }
  }
}
