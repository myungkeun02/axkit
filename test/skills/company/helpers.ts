import type {
  MailMessage,
  MailQuery,
  MailReader,
  MailSummary,
  Notice,
  NoticeResult,
  Notifier,
} from '../../../src/core/contracts/index.js';
import type {
  ConversationRef,
  IncomingMessage,
  OutgoingMessage,
  Replier,
} from '../../../src/core/conversation/types.js';
import type { PluginContext } from '../../../src/core/plugin/types.js';
import type { FakeScheduler } from '../../support/context.js';
import { createTestContext } from '../../support/context.js';
import type {
  CompanyConfig,
  CompanyLimits,
  CompanyTask,
  TeamConfig,
} from '../../../src/skills/company/types.js';
import type { IntakeDeps } from '../../../src/skills/company/intake.js';
import type { IntakeTexts } from '../../../src/skills/company/locale-intake.js';
import { intakeTexts } from '../../../src/skills/company/locale-intake.js';
import { KvTaskRepository } from '../../../src/skills/company/store.js';
import type { MapKeyValueStore } from '../../core/helpers.js';
import type { InMemoryEventBus } from '../../../src/core/events/bus.js';

export const NOW = new Date('2026-11-18T09:00:00+09:00');
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export function team(partial: Partial<TeamConfig> & { id: string; name: string }): TeamConfig {
  return {
    role: `${partial.name} work`,
    scope: [],
    lead: { tier: 'standard' },
    member: { tier: 'fast' },
    sensitivity: 'masked',
    kind: 'general',
    ...partial,
  };
}

export const DEV = team({ id: 'dev', name: '개발', scope: ['개발', '버그'] });
export const MARKETING = team({ id: 'marketing', name: '마케팅', scope: ['마케팅', '광고'] });

export function companyConfig(overrides: Partial<CompanyConfig> = {}): CompanyConfig {
  return {
    teams: [DEV, MARKETING],
    limits: {
      maxOpen: 6,
      maxOpenPerTeam: 2,
      maxAgeHours: 72,
      ownerWaitDays: 7,
      maxRevisions: 1,
      maxSteps: 4,
    },
    dailyUsd: 0.3,
    reportAt: '18:00',
    prefix: '회사',
    mailIntake: { enabled: false, query: '', everyMinutes: 30 },
    ...overrides,
  };
}

export function task(partial: Partial<CompanyTask> & { id: string }): CompanyTask {
  return {
    team: 'dev',
    title: '일',
    request: '일을 해 주세요',
    source: 'owner',
    status: 'queued',
    steps: [],
    ownerEffects: [],
    revisions: 0,
    approvals: [],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...partial,
  };
}

export class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return 'sent';
  }
}

export class FakeMail implements MailReader {
  items: MailSummary[] = [];
  readonly queries: MailQuery[] = [];

  async search(query: MailQuery): Promise<MailSummary[]> {
    this.queries.push(query);
    return this.items.slice(0, query.limit);
  }

  async read(id: string): Promise<MailMessage> {
    throw new Error(`unused read: ${id}`);
  }
}

export function mailSummary(
  id: string,
  subject: string,
  snippet = '본문 미리보기',
  at: Date = NOW,
): MailSummary {
  return {
    id,
    threadId: `thread-${id}`,
    from: 'sender@example.com',
    subject,
    snippet,
    receivedAt: at,
    unread: true,
    important: false,
  };
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

export function message(text: string, fromOwner = true): IncomingMessage {
  return {
    id: 'msg-1',
    conversation: { channelId: 'test', address: 'owner' },
    authorId: fromOwner ? 'owner' : 'someone',
    fromOwner,
    text,
    receivedAt: NOW,
  };
}

export interface IntakeSetup {
  ctx: PluginContext;
  deps: IntakeDeps;
  repo: KvTaskRepository;
  kv: MapKeyValueStore;
  scheduler: FakeScheduler;
  bus: InMemoryEventBus;
  texts: IntakeTexts;
}

export interface IntakeOptions {
  config?: Partial<CompanyConfig>;
  classify?: (request: string) => Promise<TeamConfig | undefined>;
  limits?: () => Promise<CompanyLimits>;
  capabilities?: Record<string, unknown>;
}

export function setupIntake(options: IntakeOptions = {}): IntakeSetup {
  const context = createTestContext({
    now: NOW,
    ...(options.capabilities !== undefined ? { capabilities: options.capabilities } : {}),
  });
  const config = companyConfig(options.config);
  const repo = new KvTaskRepository(context.kv, () => context.clock.now());
  const texts = intakeTexts('ko');
  const deps: IntakeDeps = {
    ctx: context.ctx,
    repo,
    config,
    limits: options.limits ?? (async () => config.limits),
    texts,
    classify: options.classify ?? (async () => undefined),
  };
  return { ctx: context.ctx, deps, repo, kv: context.kv, scheduler: context.scheduler, bus: context.bus, texts };
}
