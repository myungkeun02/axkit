import { Contracts } from '../../../src/core/contracts/index.js';
import type {
  CardFeedback,
  Notice,
  NoticeMuter,
  NoticeResult,
  Notifier,
} from '../../../src/core/contracts/index.js';
import type {
  ConversationRef,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  Replier,
} from '../../../src/core/conversation/types.js';
import { tuningSkill } from '../../../src/skills/tuning/plugin.js';
import { TuningStore } from '../../../src/skills/tuning/store.js';
import type { TestContext, TestContextOptions } from '../../support/context.js';
import { createTestContext } from '../../support/context.js';

export const NOW = new Date('2026-11-17T09:00:00+09:00');
export const SUNDAY = new Date('2026-11-15T19:00:00+09:00');
export const TIME_ZONE = 'Asia/Seoul';
export const DAY_MS = 86_400_000;

export class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  result: NoticeResult = 'sent';

  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return this.result;
  }
}

export class FakeMuter implements NoticeMuter {
  readonly kinds = new Set<string>();

  async mute(kind: string): Promise<void> {
    this.kinds.add(kind);
  }

  async unmute(kind: string): Promise<void> {
    this.kinds.delete(kind);
  }

  async muted(): Promise<readonly string[]> {
    return [...this.kinds];
  }
}

export interface SetupResult {
  context: TestContext;
  notifier: FakeNotifier;
  muter: FakeMuter;
}

export async function setupTuning(options: TestContextOptions = {}): Promise<SetupResult> {
  const notifier = new FakeNotifier();
  const muter = new FakeMuter();
  const context = createTestContext({
    ...options,
    now: options.now ?? NOW,
    capabilities: {
      [Contracts.notifier.id]: notifier,
      [Contracts.noticeMute.id]: muter,
      ...(options.capabilities ?? {}),
    },
  });
  await tuningSkill().setup(context.ctx);
  return { context, notifier, muter };
}

export interface FeedbackOptions {
  correction?: string;
  label?: string;
  at?: Date;
}

export function feedback(
  domain: string,
  subject: string,
  verdict: CardFeedback['verdict'],
  options: FeedbackOptions = {},
): CardFeedback {
  return {
    domain,
    subject,
    verdict,
    at: options.at ?? NOW,
    ...(options.correction !== undefined ? { correction: options.correction } : {}),
    ...(options.label !== undefined ? { label: options.label } : {}),
  };
}

export async function emitFeedback(context: TestContext, items: readonly CardFeedback[]): Promise<void> {
  for (const item of items) await context.bus.emit('feedback.card', item);
}

export function storeOf(context: TestContext): TuningStore {
  return new TuningStore(context.kv, () => context.clock.now());
}

export function handlerOf(context: TestContext): MessageHandler {
  const handler = context.handlers.find((candidate) => candidate.id === 'tuning.buttons');
  if (handler === undefined) throw new Error('tuning button handler not registered');
  return handler;
}

export function makeReplier(): { replier: Replier; replies: OutgoingMessage[] } {
  const replies: OutgoingMessage[] = [];
  const replier: Replier = {
    async reply(_conversation: ConversationRef, message: OutgoingMessage) {
      replies.push(message);
    },
  };
  return { replier, replies };
}

export function choiceMessage(text: string, fromOwner = true): IncomingMessage {
  return {
    id: 'm1',
    conversation: { channelId: 'test', address: 'owner' },
    authorId: 'owner',
    fromOwner,
    text,
    receivedAt: NOW,
  };
}
