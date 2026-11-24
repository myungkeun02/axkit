import type { BrowserAgent, BrowserRunResult, BrowserTask } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { Confirmer } from '../../../src/core/policy/types.js';
import { browserSkill } from '../../../src/skills/browser/plugin.js';
import { createTestContext } from '../../support/context.js';
import type { TestContext } from '../../support/context.js';
import { settler } from '../work/settle.js';
import type { Settler } from '../work/settle.js';
import type { Notice, NoticeResult, Notifier } from '../../../src/core/contracts/index.js';
import type { BrowserRunOutput } from '../../../src/skills/browser/output.js';

export class RecordingNotifier implements Notifier {
  readonly notices: Notice[] = [];
  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return 'sent';
  }
}

export class FakeBrowserAgent implements BrowserAgent {
  readonly label = 'Fake browser';
  readonly reads: string[] = [];
  readonly tasks: BrowserTask[] = [];
  readonly opened: string[] = [];
  result: BrowserRunResult = { status: 'done', summary: '페이지 내용', url: 'https://example.com/' };
  openError: Error | undefined;
  deferOpen = false;
  private release: (() => void) | undefined;

  async read(url: string): Promise<BrowserRunResult> {
    this.reads.push(url);
    return this.result;
  }

  async run(task: BrowserTask): Promise<BrowserRunResult> {
    this.tasks.push(task);
    return this.result;
  }

  async openForHuman(url: string): Promise<void> {
    this.opened.push(url);
    if (this.openError !== undefined) throw this.openError;
    if (!this.deferOpen) return;
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  releaseOpen(): void {
    this.release?.();
  }
}

export class ReadOnlyBrowserAgent implements BrowserAgent {
  readonly label = 'Fake read-only browser';

  async read(): Promise<BrowserRunResult> {
    return { status: 'done', summary: 'ok' };
  }

  async run(): Promise<BrowserRunResult> {
    return { status: 'done', summary: 'ok' };
  }
}

export interface SetupOptions {
  agent?: BrowserAgent;
  language?: string;
  confirmer?: Confirmer;
}

export interface BrowserTestContext extends TestContext {
  agent: BrowserAgent;
  notifier: RecordingNotifier;
  settled: Settler;
  /** Runs browser.task and waits for its background result. */
  task(input: Record<string, unknown>): Promise<BrowserRunOutput>;
}

export async function setup(options: SetupOptions = {}): Promise<BrowserTestContext> {
  const agent = options.agent ?? new FakeBrowserAgent();
  const notifier = new RecordingNotifier();
  const settled = settler();
  const context = createTestContext({
    capabilities: { [Contracts.browser.id]: agent, [Contracts.notifier.id]: notifier },
    ...(options.language !== undefined ? { assistant: { language: options.language } } : {}),
    ...(options.confirmer !== undefined ? { confirmer: options.confirmer } : {}),
  });
  await browserSkill({ onSettled: settled.onSettled }).setup(context.ctx);
  const task = async (input: Record<string, unknown>): Promise<BrowserRunOutput> => {
    const outcome = await context.ctx.tools.execute('browser.task', input);
    if (outcome.status !== 'done') throw new Error(`browser.task: ${outcome.status}`);
    return settled.next<BrowserRunOutput>();
  };
  return { ...context, agent, notifier, settled, task };
}
