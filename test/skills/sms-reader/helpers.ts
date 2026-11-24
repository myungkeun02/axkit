import { z } from 'zod';
import type { Notice, NoticeResult, Notifier, PhoneSms } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { LlmGateway } from '../../../src/core/llm/types.js';
import { AUTONOMY_MIGRATIONS, SqliteAutonomyRules } from '../../../src/core/policy/autonomy.js';
import { OwnerQuestions } from '../../../src/core/policy/questions.js';
import { SqliteTopicAnswers, TOPIC_MIGRATIONS } from '../../../src/core/policy/topics.js';
import { openSqliteStore } from '../../../src/core/store/sqlite.js';
import { dateMentioned, evidenceFound, timeMentioned } from '../../../src/core/time/evidence.js';
import type { DateSpec, TimeSpec } from '../../../src/core/time/date-spec.js';
import type { SmsReader } from '../../../src/skills/sms-reader/reader.js';
import { smsReaderSkill } from '../../../src/skills/sms-reader/plugin.js';
import { createTestContext, FakeConfirmer, ScriptedLlm } from '../../support/context.js';
import type { TestContext } from '../../support/context.js';

export const NOW = new Date('2026-11-23T09:00:00+09:00');

export class RecordingNotifier implements Notifier {
  readonly notices: Notice[] = [];
  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return 'sent';
  }
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  grounding: readonly string[];
}

const eventInput = z.object({
  title: z.string(),
  date: z.custom<DateSpec>(),
  time: z.custom<TimeSpec>().optional(),
  location: z.string().optional(),
  evidence: z.string(),
});

export interface ParcelReply {
  state: string;
  delivered: boolean;
}

export interface ReaderTestContext extends TestContext {
  notifier: RecordingNotifier;
  confirmer: FakeConfirmer;
  calls: ToolCall[];
  autonomy: SqliteAutonomyRules;
  parcelReplies: ParcelReply[];
  reader: SmsReader;
  send(sms: Partial<PhoneSms>): Promise<void>;
}

export interface SetupOptions {
  llm?: LlmGateway;
  config?: Record<string, unknown>;
  answer?: 'approved' | 'denied' | 'expired';
  parcel?: boolean;
  language?: string;
}

/** Real policy executor, topics and autonomy rules; fake calendar, to-do and parcel tools that record their calls. */
export async function setup(options: SetupOptions = {}): Promise<ReaderTestContext> {
  const notifier = new RecordingNotifier();
  const confirmer = new FakeConfirmer(options.answer ?? 'approved');
  const store = openSqliteStore(':memory:');
  await store.migrate([...TOPIC_MIGRATIONS, ...AUTONOMY_MIGRATIONS]);
  const topics = new SqliteTopicAnswers(store.sql, () => NOW);
  const questions = new OwnerQuestions({ topics, confirmer: () => confirmer, now: () => NOW });
  const autonomy = new SqliteAutonomyRules(store.sql, () => NOW);
  const context = createTestContext({
    now: NOW,
    llm: options.llm ?? new ScriptedLlm(),
    confirmer,
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.language !== undefined ? { assistant: { language: options.language } } : {}),
    capabilities: {
      [Contracts.notifier.id]: notifier,
      [Contracts.questions.id]: questions,
      [Contracts.autonomy.id]: autonomy,
    },
  });
  const calls: ToolCall[] = [];
  const parcelReplies: ParcelReply[] = [];
  context.registry.register({
    name: 'calendar.add_event',
    description: 'fake',
    input: eventInput,
    effects: ['write'],
    // the real tool's evidence check, so a quote that is not in the message is refused here too
    reject: (input, call) =>
      !evidenceFound(input.evidence, call.grounding) || !dateMentioned(input.date, input.evidence) ||
      (input.time !== undefined && !timeMentioned(input.time, input.evidence))
        ? 'evidence'
        : undefined,
    async run(input, run) {
      calls.push({ name: 'calendar.add_event', input, grounding: run.call.grounding });
      return { status: 'created' };
    },
  });
  context.registry.register({
    name: 'todo.add',
    description: 'fake',
    input: z.record(z.string(), z.unknown()),
    effects: ['write'],
    async run(input, run) {
      calls.push({ name: 'todo.add', input, grounding: run.call.grounding });
      return { id: 't1' };
    },
  });
  if (options.parcel !== false) {
    context.registry.register({
      name: 'life.parcel',
      description: 'fake',
      input: z.object({ carrier: z.string(), invoice: z.string() }),
      effects: ['read'],
      async run(input, run) {
        calls.push({ name: 'life.parcel', input, grounding: run.call.grounding });
        const reply = parcelReplies.shift() ?? { state: '배송중', delivered: false };
        return { status: 'ok', parcel: { carrier: input.carrier, invoice: input.invoice, ...reply }, note: 'data' };
      },
    });
  }
  let reader: SmsReader | undefined;
  await smsReaderSkill({ onReader: (r) => (reader = r) }).setup(context.ctx);
  if (reader === undefined) throw new Error('no reader');
  const ready = reader;
  let counter = 0;
  const send = async (sms: Partial<PhoneSms>): Promise<void> => {
    counter += 1;
    await context.bus.emit('phone.sms', { deviceId: 'd1', text: '', at: NOW, ref: `sms:test${counter}`, ...sms });
    await ready.idle();
  };
  return { ...context, notifier, confirmer, calls, autonomy, parcelReplies, reader: ready, send };
}
