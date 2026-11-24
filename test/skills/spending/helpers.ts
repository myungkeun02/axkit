import type {
  MailMessage,
  MailQuery,
  MailReader,
  MailSummary,
  Notice,
  NoticeResult,
  Notifier,
  PaymentNotice,
  SpendReader,
} from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { spendingSkill } from '../../../src/skills/spending/plugin.js';
import type { TestContext } from '../../support/context.js';
import type { TestContextOptions } from '../../support/context.js';
import { createTestContext } from '../../support/context.js';

export const NOW = new Date('2026-11-17T09:00:00+09:00');
export const TIME_ZONE = 'Asia/Seoul';

export class FakeMailReader implements MailReader {
  readonly queries: MailQuery[] = [];
  constructor(public messages: MailMessage[] = []) {}

  async search(query: MailQuery): Promise<MailSummary[]> {
    this.queries.push(query);
    return this.messages.map((message) => ({
      id: message.id,
      threadId: message.threadId,
      from: message.from,
      subject: message.subject,
      snippet: message.snippet,
      receivedAt: message.receivedAt,
      unread: message.unread,
      important: message.important,
    }));
  }

  async read(id: string): Promise<MailMessage> {
    const found = this.messages.find((message) => message.id === id);
    if (found === undefined) throw new Error(`no message ${id}`);
    return found;
  }
}

export class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return 'sent';
  }
}

export function mailMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  return {
    id: 'm1',
    threadId: 't1',
    from: '카페 예시 <receipts@example.com>',
    to: ['owner@example.com'],
    cc: [],
    subject: '주문 완료',
    snippet: '합계 12,300원',
    body: '주문하신 상품\n합계 12,300원',
    receivedAt: NOW,
    unread: true,
    important: false,
    ...overrides,
  };
}

export function notice(overrides: Partial<PaymentNotice> & { text: string }): PaymentNotice {
  return {
    source: 'sms',
    at: NOW,
    ...overrides,
  };
}

export async function setupSpending(options: TestContextOptions = {}): Promise<TestContext> {
  const context = createTestContext({ now: NOW, ...options });
  await spendingSkill().setup(context.ctx);
  return context;
}

export function spendReader(context: TestContext): SpendReader {
  return context.ctx.use(Contracts.spendRead);
}

export function registeredTool(context: TestContext, name: string) {
  return context.registry.get(name);
}
