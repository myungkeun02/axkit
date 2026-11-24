import { z } from 'zod';
import type {
  CardFeedback,
  ChatPreview,
  Notice,
  NoticeMuter,
  NoticeResult,
  Notifier,
  PaymentNotice,
  PeopleWriter,
  PersonInteraction,
} from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { Replier } from '../../../src/core/conversation/types.js';
import type { LlmGateway } from '../../../src/core/llm/types.js';
import type { Tool } from '../../../src/core/tools/types.js';
import { chatInboxSkill } from '../../../src/skills/chat-inbox/plugin.js';
import { createTestContext } from '../../support/context.js';
import type { TestContext } from '../../support/context.js';

export const NOW = new Date('2026-11-17T09:00:00+09:00');

export class RecordingNotifier implements Notifier {
  readonly notices: Notice[] = [];

  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return 'sent';
  }
}

export interface NoteCall {
  identity: { name?: string; email?: string };
  interaction: PersonInteraction;
}

export class FakePeople implements PeopleWriter {
  readonly calls: NoteCall[] = [];

  async noteInteraction(identity: { name?: string; email?: string }, interaction: PersonInteraction): Promise<void> {
    this.calls.push({ identity, interaction });
  }
}

export class FakeNoticeMute implements NoticeMuter {
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

export interface CalendarCall {
  input: Record<string, unknown>;
  grounding: readonly string[];
}

export class FakeCalendar {
  readonly calls: CalendarCall[] = [];
}

const calendarInput = z.object({
  title: z.string(),
  date: z.unknown(),
  time: z.unknown().optional(),
  evidence: z.string(),
});

export function calendarAddTool(calendar: FakeCalendar): Tool<z.infer<typeof calendarInput>, { status: 'created' }> {
  return {
    name: 'calendar.add_event',
    description: 'Fake calendar for tests.',
    input: calendarInput,
    effects: ['write'],
    async run(input, runContext) {
      calendar.calls.push({ input, grounding: runContext.call.grounding });
      return { status: 'created' };
    },
  };
}

export interface SetupOptions {
  now?: Date;
  language?: string;
  config?: Record<string, unknown>;
  llm?: LlmGateway;
  capabilities?: Record<string, unknown>;
  calendar?: boolean;
}

export interface ChatInboxTestContext extends TestContext {
  notifier: RecordingNotifier;
  people: FakePeople;
  muter: FakeNoticeMute;
  calendar: FakeCalendar;
}

export async function setup(options: SetupOptions = {}): Promise<ChatInboxTestContext> {
  const notifier = new RecordingNotifier();
  const people = new FakePeople();
  const muter = new FakeNoticeMute();
  const calendar = new FakeCalendar();
  const capabilities: Record<string, unknown> = {
    [Contracts.notifier.id]: notifier,
    [Contracts.peopleWrite.id]: people,
    [Contracts.noticeMute.id]: muter,
    ...(options.capabilities ?? {}),
  };
  const context = createTestContext({
    now: options.now ?? NOW,
    ...(options.language !== undefined ? { assistant: { language: options.language } } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.llm !== undefined ? { llm: options.llm } : {}),
    capabilities,
  });
  if (options.calendar !== false) context.registry.register(calendarAddTool(calendar));
  await chatInboxSkill().setup(context.ctx);
  return { ...context, notifier, people, muter, calendar };
}

let previewCounter = 0;

export function preview(overrides: Partial<ChatPreview> = {}): ChatPreview {
  previewCounter += 1;
  return {
    app: 'kakao',
    room: '민수',
    text: '그거 확인해줘',
    unread: 1,
    direct: true,
    at: NOW,
    ref: `ref-${previewCounter}`,
    ...overrides,
  };
}

export async function emitPreview(context: ChatInboxTestContext, payload: ChatPreview): Promise<void> {
  await context.bus.emit('chat.preview', payload);
}

export function collectFeedback(context: TestContext): CardFeedback[] {
  const items: CardFeedback[] = [];
  context.bus.on('feedback.card', (payload) => {
    items.push(payload);
  });
  return items;
}

export function collectMoney(context: TestContext): PaymentNotice[] {
  const items: PaymentNotice[] = [];
  context.bus.on('money.notice', (payload) => {
    items.push(payload);
  });
  return items;
}

export interface PressResult {
  result: 'handled' | 'pass';
  replies: string[];
}

export async function press(context: ChatInboxTestContext, text: string, fromOwner = true): Promise<PressResult> {
  const handler = context.handlers[0];
  if (handler === undefined) throw new Error('chat-inbox registered no handler');
  const replies: string[] = [];
  const replier: Replier = {
    async reply(_to, message) {
      replies.push(message.text);
    },
  };
  const result = await handler.handle(
    {
      id: 'owner-message',
      conversation: { channelId: 'dm', address: 'owner' },
      authorId: 'owner',
      fromOwner,
      text,
      receivedAt: context.clock.now(),
    },
    replier,
  );
  return { result, replies };
}
