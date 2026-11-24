import type {
  BrowserAgent,
  BrowserLiveHub,
  BrowserRunResult,
  BrowserTask,
  HandoffReason,
  LiveState,
  Notice,
  NoticeResult,
  Notifier,
} from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { ConversationRef } from '../../../src/core/conversation/types.js';
import { errandsSkill } from '../../../src/skills/errands/plugin.js';
import { FakeConfirmer, createTestContext } from '../../support/context.js';
import type { TestContext } from '../../support/context.js';
import { settler } from '../work/settle.js';
import type { Settler } from '../work/settle.js';

export const NOW = new Date('2026-11-23T09:00:00+09:00');

/** Answers each run from a queue (the last answer repeats); never touches a real site. */
export class FakeBrowserAgent implements BrowserAgent {
  readonly label = 'Fake browser';
  readonly tasks: BrowserTask[] = [];
  readonly runTimes: number[] = [];
  results: BrowserRunResult[] = [{ status: 'done', summary: 'SEATS: no' }];
  now: () => number = () => 0;

  async read(): Promise<BrowserRunResult> {
    throw new Error('errands never read without a task');
  }

  async run(task: BrowserTask): Promise<BrowserRunResult> {
    this.tasks.push(task);
    this.runTimes.push(this.now());
    const next = this.results.length > 1 ? this.results.shift() : this.results[0];
    if (next === undefined) throw new Error('no scripted result');
    return next;
  }
}

export class FakeLiveHub implements BrowserLiveHub {
  readonly offers: { url: string; reason: HandoffReason; origin?: ConversationRef }[] = [];
  live = false;
  state(): LiveState {
    return { live: this.live };
  }
  offer(url: string, reason: HandoffReason, origin?: ConversationRef): void {
    this.offers.push({ url, reason, ...(origin !== undefined ? { origin } : {}) });
  }
  async start(): Promise<boolean> {
    return false;
  }
  async frame(): Promise<undefined> {
    return undefined;
  }
  async input(): Promise<'not_live'> {
    return 'not_live';
  }
  async finish(): Promise<{ wasLive: boolean }> {
    return { wasLive: false };
  }
  subscribe(): () => void {
    return () => undefined;
  }
}

export class RecordingNotifier implements Notifier {
  readonly notices: Notice[] = [];
  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return 'sent';
  }
}

export interface ErrandsTestContext extends TestContext {
  agent: FakeBrowserAgent;
  confirmer: FakeConfirmer;
  notifier: RecordingNotifier;
  live?: FakeLiveHub;
  settled: Settler;
}

export async function setup(options: { app?: boolean; answer?: 'approved' | 'denied'; stopped?: boolean } = {}): Promise<ErrandsTestContext> {
  const agent = new FakeBrowserAgent();
  const confirmer = new FakeConfirmer(options.answer ?? 'approved');
  const notifier = new RecordingNotifier();
  const live = options.app === true ? new FakeLiveHub() : undefined;
  const context = createTestContext({
    now: NOW,
    confirmer,
    capabilities: {
      [Contracts.browser.id]: agent,
      [Contracts.notifier.id]: notifier,
      ...(live !== undefined ? { [Contracts.browserLive.id]: live, [Contracts.appViews.id]: { register: () => undefined } } : {}),
      ...(options.stopped === true ? { [Contracts.killSwitch.id]: { state: async () => ({ stopped: true }) } } : {}),
    },
  });
  agent.now = () => context.clock.now().getTime();
  const settled = settler();
  await errandsSkill({ onSettled: settled.onSettled }).setup(context.ctx);
  return { ...context, agent, confirmer, notifier, settled, ...(live !== undefined ? { live } : {}) };
}

export const TRAIN = {
  operator: 'ktx',
  from: '서울',
  to: '부산',
  date: '2026-11-28',
  time: '08:00',
  adults: 2,
  preference: '가장 빨리 도착하는 것',
} as const;

export const TABLE = { place: '을지로 스시 하루', date: '2026-11-28', time: '19:00', partySize: 4 } as const;

export function minutes(context: TestContext, value: number): Date {
  return new Date(context.clock.now().getTime() + value * 60_000);
}
