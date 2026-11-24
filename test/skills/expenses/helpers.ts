import type {
  MailComposer,
  MailDrafter,
  MailDraft,
  NewMailDraft,
  Notice,
  NoticeResult,
  Notifier,
  SpendEntry,
  SpendReader,
} from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { IncomingMessage, OutgoingMessage, Replier } from '../../../src/core/conversation/types.js';
import type { PluginContext } from '../../../src/core/plugin/types.js';
import type { Confirmer } from '../../../src/core/policy/types.js';
import type { LlmGateway } from '../../../src/core/llm/types.js';
import { expensesSkill } from '../../../src/skills/expenses/plugin.js';
import type { RuleConfig } from '../../../src/skills/expenses/config.js';
import { createTestContext } from '../../support/context.js';

export const NOW = new Date('2026-11-17T09:00:00+09:00');

export class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  result: NoticeResult = 'sent';
  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return this.result;
  }
}

export class FakeReplier implements Replier {
  readonly replies: { to: unknown; message: OutgoingMessage }[] = [];
  async reply(to: unknown, message: OutgoingMessage): Promise<void> {
    this.replies.push({ to, message });
  }
}

export class FakeSpendReader implements SpendReader {
  readonly ranges: { from: Date; to: Date }[] = [];
  constructor(
    public list: SpendEntry[] = [],
    private readonly currency = 'KRW',
  ) {}
  async entries(range: { from: Date; to: Date }): Promise<SpendEntry[]> {
    this.ranges.push(range);
    return this.list.filter((entry) => {
      const at = Date.parse(entry.at);
      return at >= range.from.getTime() && at < range.to.getTime();
    });
  }
  homeCurrency(): string {
    return this.currency;
  }
}

export class FakeComposer implements MailComposer {
  readonly drafts: NewMailDraft[] = [];
  constructor(private readonly draftId = 'draft-1') {}
  async draftNew(draft: NewMailDraft): Promise<MailDraft> {
    this.drafts.push(draft);
    return {
      draftId: this.draftId,
      to: draft.to,
      cc: draft.cc ?? [],
      subject: draft.subject,
      body: draft.body,
    };
  }
}

export class FakeDrafter implements MailDrafter {
  readonly drafts = new Map<string, MailDraft>();
  add(draft: MailDraft): void {
    this.drafts.set(draft.draftId, draft);
  }
  async draftReply(): Promise<MailDraft> {
    throw new Error('not used');
  }
  async getDraft(draftId: string): Promise<MailDraft> {
    const draft = this.drafts.get(draftId);
    if (draft === undefined) throw new Error('missing draft');
    return draft;
  }
}

export function entry(overrides: Partial<SpendEntry> = {}): SpendEntry {
  const merchant = overrides.merchant ?? '카페 예시';
  return {
    id: 'e1',
    at: '2026-11-03T12:00:00+09:00',
    merchant,
    merchantKey: overrides.merchantKey ?? merchant.toLowerCase(),
    amount: 5000,
    currency: 'KRW',
    originalAmount: 5000,
    source: 'sms',
    category: 'food',
    categorySource: 'rule',
    ...overrides,
  };
}

export function rule(overrides: Partial<RuleConfig> = {}): RuleConfig {
  return { id: 'lunch', name: '평일 점심 식대', ...overrides };
}

export function incoming(text: string, fromOwner = true): IncomingMessage {
  return {
    id: 'in-1',
    conversation: { channelId: 'discord', address: 'dm' },
    authorId: 'owner',
    fromOwner,
    text,
    receivedAt: NOW,
  };
}

export interface SetupOptions {
  now?: Date;
  config?: Record<string, unknown>;
  entries?: SpendEntry[];
  currency?: string;
  confirmer?: Confirmer;
  assistant?: Partial<PluginContext['assistant']>;
  capabilities?: Record<string, unknown>;
  withSpend?: boolean;
  llm?: LlmGateway;
}

export async function setup(options: SetupOptions = {}) {
  const notifier = new FakeNotifier();
  const reader = new FakeSpendReader(options.entries ?? [], options.currency ?? 'KRW');
  const capabilities: Record<string, unknown> = {
    [Contracts.notifier.id]: notifier,
    ...(options.withSpend === false ? {} : { [Contracts.spendRead.id]: reader }),
    ...(options.capabilities ?? {}),
  };
  const context = createTestContext({
    now: options.now ?? NOW,
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.assistant !== undefined ? { assistant: options.assistant } : {}),
    ...(options.confirmer !== undefined ? { confirmer: options.confirmer } : {}),
    ...(options.llm !== undefined ? { llm: options.llm } : {}),
    capabilities,
  });
  await expensesSkill().setup(context.ctx);
  return { notifier, reader, ...context };
}
