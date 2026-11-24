import type {
  PlaywrightContext,
  PlaywrightLike,
  PlaywrightPage,
} from '../../../src/connectors/browser/playwright-agent.js';
import type { ProcessRunner, RunOptions, RunResult } from '../../../src/core/process/types.js';

export interface FakeBrowserState {
  title: string;
  text: string;
  url: string;
}

export interface GotoOptions {
  timeout: number;
  waitUntil: 'domcontentloaded';
}

export class FakePage implements PlaywrightPage {
  closed = false;
  lastGoto: GotoOptions | undefined;
  private readonly closeWaiters: (() => void)[] = [];

  constructor(private readonly state: FakeBrowserState) {}

  async goto(url: string, options: GotoOptions): Promise<void> {
    this.state.url = url;
    this.lastGoto = options;
  }

  async title(): Promise<string> {
    return this.state.title;
  }

  async innerText(): Promise<string> {
    return this.state.text;
  }

  url(): string {
    return this.state.url;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.closeWaiters) resolve();
  }

  waitForEvent(): Promise<unknown> {
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.closeWaiters.push(() => resolve(undefined));
    });
  }
}

export class FakeContext implements PlaywrightContext {
  readonly pages: FakePage[] = [];
  closed = false;
  private readonly closeListeners: (() => void)[] = [];

  constructor(
    private readonly state: FakeBrowserState,
    readonly dir: string,
    readonly options: { headless: boolean },
  ) {}

  async newPage(): Promise<FakePage> {
    const page = new FakePage(this.state);
    this.pages.push(page);
    return page;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  on(_event: 'close', listener: () => void): unknown {
    this.closeListeners.push(listener);
    return this;
  }
}

export interface Launch {
  dir: string;
  options: { headless: boolean };
  context: FakeContext;
}

export interface FakePlaywright {
  launches: Launch[];
  load: () => Promise<PlaywrightLike>;
}

export function fakePlaywright(overrides: Partial<FakeBrowserState> = {}): FakePlaywright {
  const state: FakeBrowserState = { title: 'Example page', text: 'hello', url: '', ...overrides };
  const launches: Launch[] = [];
  return {
    launches,
    load: async () => ({
      chromium: {
        async launchPersistentContext(dir, options) {
          const context = new FakeContext(state, dir, options);
          launches.push({ dir, options, context });
          return context;
        },
      },
    }),
  };
}

export interface RunCall {
  cmd: string;
  args: readonly string[];
  opts: RunOptions;
}

export interface FakeRunner {
  calls: RunCall[];
  run: ProcessRunner;
}

export function fakeRunner(
  answer: Partial<RunResult> | ((cmd: string, args: readonly string[], opts: RunOptions) => Partial<RunResult>) = {},
): FakeRunner {
  const calls: RunCall[] = [];
  const run: ProcessRunner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const extra = typeof answer === 'function' ? answer(cmd, args, opts) : answer;
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...extra };
  };
  return { calls, run };
}
