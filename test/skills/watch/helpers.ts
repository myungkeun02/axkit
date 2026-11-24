import { expect } from 'vitest';
import type {
  Notice,
  NoticeResult,
  Notifier,
  PageReader,
  PriceOffer,
  PriceSearch,
  WebPage,
} from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { PluginContext } from '../../../src/core/plugin/types.js';
import { watchSkill } from '../../../src/skills/watch/plugin.js';
import type { WatchAddInput, WatchAddOutput } from '../../../src/skills/watch/tool-add.js';
import type { Watch } from '../../../src/skills/watch/types.js';
import { createTestContext } from '../../support/context.js';
import type { TestContext } from '../../support/context.js';

export const NOW = new Date('2026-11-17T09:00:00+09:00');

export class RecordingNotifier implements Notifier {
  readonly notices: Notice[] = [];

  constructor(private readonly inner?: Notifier) {}

  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return this.inner === undefined ? 'sent' : this.inner.notify(notice);
  }
}

export class FakePrices implements PriceSearch {
  offers: PriceOffer[] = [];
  readonly calls: string[] = [];
  fail = false;

  async lowest(query: string, limit: number): Promise<PriceOffer[]> {
    this.calls.push(query);
    if (this.fail) throw new Error('price service down');
    return this.offers.slice(0, limit);
  }
}

export class FakePages implements PageReader {
  readonly pages = new Map<string, string>();
  readonly calls: string[] = [];
  fail = false;

  async read(url: string): Promise<WebPage> {
    this.calls.push(url);
    if (this.fail) throw new Error('page reader down');
    const text = this.pages.get(url);
    if (text === undefined) throw new Error('page not found in fake');
    return { url, status: 200, text, fetchedAt: NOW };
  }
}

export interface SetupOptions {
  now?: Date;
  language?: string;
  timeZone?: string;
  prices?: PriceSearch;
  pages?: PageReader;
  notifier?: Notifier;
}

export interface WatchTestContext extends TestContext {
  notifier: RecordingNotifier;
}

export async function setup(options: SetupOptions = {}): Promise<WatchTestContext> {
  const notifier = new RecordingNotifier(options.notifier);
  const capabilities: Record<string, unknown> = { [Contracts.notifier.id]: notifier };
  if (options.prices !== undefined) capabilities[Contracts.prices.id] = options.prices;
  if (options.pages !== undefined) capabilities[Contracts.webPage.id] = options.pages;

  const assistant: Partial<PluginContext['assistant']> = {
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(options.timeZone !== undefined ? { timezone: options.timeZone } : {}),
  };
  const context = createTestContext({
    now: options.now ?? NOW,
    ...(Object.keys(assistant).length > 0 ? { assistant } : {}),
    capabilities,
  });
  await watchSkill().setup(context.ctx);
  return { ...context, notifier };
}

export async function addWatchId(context: WatchTestContext, input: WatchAddInput): Promise<string> {
  const outcome = await context.ctx.tools.execute('watch.add', input);
  if (outcome.status !== 'done') throw new Error(`watch.add failed: ${outcome.status}`);
  const output = outcome.output as WatchAddOutput;
  expect(output.status).toBe('ok');
  if (output.status !== 'ok') throw new Error('watch was not added');
  return output.watch.id;
}

export function at(context: WatchTestContext, minutes: number): Date {
  return new Date(context.clock.now().getTime() + minutes * 60_000);
}

export async function sweep(context: WatchTestContext, atTime: Date): Promise<void> {
  await context.scheduler.run('watch.sweep', atTime);
}

export async function storedWatches(context: WatchTestContext): Promise<Watch[]> {
  return (await context.kv.get<Watch[]>('watches')) ?? [];
}

export async function storedWatch(context: WatchTestContext, id: string): Promise<Watch | undefined> {
  return (await storedWatches(context)).find((watch) => watch.id === id);
}
