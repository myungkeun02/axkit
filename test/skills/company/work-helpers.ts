import type {
  FailureCount,
  FailureReport,
  FeatureHealth,
  FeatureSwitches,
  PauseInput,
  PauseState,
  PurposeUsage,
  UsageReader,
} from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { Notice, NoticeResult, Notifier } from '../../../src/core/contracts/notify.js';
import type { Doc, DocEntry, DocInput, DocQuery, DocStore } from '../../../src/core/contracts/docs.js';
import type { LlmGateway } from '../../../src/core/llm/types.js';
import type { Confirmer } from '../../../src/core/policy/types.js';
import { KvDocStore } from '../../../src/core/docs/kv-doc-store.js';
import { CompanyPipeline } from '../../../src/skills/company/pipeline.js';
import { workTexts } from '../../../src/skills/company/locale-work.js';
import type { WorkTexts } from '../../../src/skills/company/locale-work.js';
import { KvTaskRepository } from '../../../src/skills/company/store.js';
import { ensureTeamDocs } from '../../../src/skills/company/team-docs.js';
import type {
  CompanyConfig,
  CompanyLimits,
  CompanyTask,
  TeamConfig,
} from '../../../src/skills/company/types.js';
import type { TestContext } from '../../support/context.js';
import { createTestContext, FakeConfirmer, ScriptedLlm } from '../../support/context.js';
import { companyConfig, MARKETING, NOW, team } from './helpers.js';

export const DEV_TEAM: TeamConfig = team({
  id: 'dev',
  name: '개발',
  scope: ['개발', '버그'],
  kind: 'dev',
  repo: 'owner/app',
});

export class FakeSwitches implements FeatureSwitches {
  private readonly paused = new Map<string, PauseState>();

  async pause(feature: string, input: PauseInput): Promise<PauseState> {
    const state: PauseState = {
      feature,
      reason: input.reason,
      until: input.until.toISOString(),
      byKind: input.by.kind,
      by: input.by.id,
      createdAt: new Date().toISOString(),
      auto: false,
    };
    this.paused.set(feature, state);
    return state;
  }

  async resume(feature: string): Promise<void> {
    this.paused.delete(feature);
  }

  async pausedState(feature: string): Promise<PauseState | undefined> {
    return this.paused.get(feature);
  }

  async list(): Promise<PauseState[]> {
    return [...this.paused.values()];
  }
}

export class FakeHealth implements FeatureHealth {
  readonly reported: FailureReport[] = [];
  readonly successes: string[] = [];

  async recordFailure(report: FailureReport): Promise<'counted' | 'paused'> {
    this.reported.push(report);
    return 'counted';
  }

  async recordSuccess(feature: string): Promise<void> {
    this.successes.push(feature);
  }

  async failures(): Promise<FailureCount[]> {
    return [];
  }
}

/** KvDocStore keeps no doc-level author, so tests that care about authorship record the input too. */
export class RecordingDocStore implements DocStore {
  readonly upserts: DocInput[] = [];
  constructor(private readonly inner: DocStore) {}

  async get(id: string): Promise<Doc | undefined> {
    return this.inner.get(id);
  }

  async list(query?: DocQuery): Promise<Doc[]> {
    return this.inner.list(query);
  }

  async upsert(input: DocInput): Promise<Doc> {
    this.upserts.push(input);
    return this.inner.upsert(input);
  }

  async append(id: string, entry: Omit<DocEntry, 'at'>): Promise<Doc | undefined> {
    return this.inner.append(id, entry);
  }

  async verify(id: string): Promise<void> {
    return this.inner.verify(id);
  }

  async flagFact(factId: string, reason: string): Promise<string[]> {
    return this.inner.flagFact(factId, reason);
  }
}

export class FakeUsage implements UsageReader {
  readonly queries: { since: Date; prefix?: string }[] = [];
  constructor(public items: PurposeUsage[] = []) {}

  async byPurpose(since: Date, prefix?: string): Promise<PurposeUsage[]> {
    this.queries.push({ since, ...(prefix !== undefined ? { prefix } : {}) });
    return this.items;
  }
}

export class DedupeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  private readonly seen = new Set<string>();

  async notify(notice: Notice): Promise<NoticeResult> {
    if (notice.dedupeKey !== undefined) {
      const key = `${notice.kind}:${notice.dedupeKey}`;
      if (this.seen.has(key)) return 'dropped';
      this.seen.add(key);
    }
    this.notices.push(notice);
    return 'sent';
  }
}

export interface PipelineSetupOptions {
  teams?: readonly TeamConfig[];
  llm?: LlmGateway;
  /** null turns the docs capability off. */
  docs?: DocStore | null;
  switches?: FakeSwitches;
  health?: FakeHealth;
  usage?: FakeUsage;
  notifier?: DedupeNotifier;
  confirmer?: Confirmer;
  limits?: Partial<CompanyLimits>;
  dailyUsd?: number;
}

export interface PipelineSetup {
  context: TestContext;
  ctx: TestContext['ctx'];
  repo: KvTaskRepository;
  pipeline: CompanyPipeline;
  config: CompanyConfig;
  texts: WorkTexts;
  docs: DocStore | undefined;
  switches: FakeSwitches;
  health: FakeHealth;
  usage: FakeUsage;
  notifier: DedupeNotifier;
  llm: ScriptedLlm;
}

export async function setupPipeline(options: PipelineSetupOptions = {}): Promise<PipelineSetup> {
  const llm = options.llm ?? new ScriptedLlm();
  const switches = options.switches ?? new FakeSwitches();
  const health = options.health ?? new FakeHealth();
  const usage = options.usage ?? new FakeUsage();
  const notifier = options.notifier ?? new DedupeNotifier();
  const context = createTestContext({
    now: NOW,
    llm,
    confirmer: options.confirmer ?? new FakeConfirmer(),
    capabilities: {
      [Contracts.switches.id]: switches,
      [Contracts.featureHealth.id]: health,
      [Contracts.usage.id]: usage,
      [Contracts.notifier.id]: notifier,
    },
  });
  const docs =
    options.docs === null ? undefined : options.docs ?? new KvDocStore(context.kv, () => context.clock.now());
  if (docs !== undefined) context.provided.set(Contracts.docs.id, docs);

  const base = companyConfig();
  const config = companyConfig({
    teams: options.teams ?? [MARKETING],
    ...(options.dailyUsd !== undefined ? { dailyUsd: options.dailyUsd } : {}),
    ...(options.limits !== undefined ? { limits: { ...base.limits, ...options.limits } } : {}),
  });
  const texts = workTexts('ko');
  if (docs !== undefined) await ensureTeamDocs(docs, config.teams, texts);

  const repo = new KvTaskRepository(context.kv, () => context.clock.now());
  const pipeline = new CompanyPipeline({ ctx: context.ctx, repo, config, limits: async () => config.limits, texts });
  return {
    context,
    ctx: context.ctx,
    repo,
    pipeline,
    config,
    texts,
    docs,
    switches,
    health,
    usage,
    notifier,
    llm: llm instanceof ScriptedLlm ? llm : new ScriptedLlm(),
  };
}

export function planJson(title: string, steps: string[], ownerEffects: string[] = []): string {
  return JSON.stringify({ title, steps, ownerEffects });
}

export function reviewJson(verdict: 'pass' | 'revise', note = ''): string {
  return JSON.stringify({ verdict, note });
}

export async function createTask(
  repo: KvTaskRepository,
  partial: Partial<CompanyTask> & { team: string } = { team: 'marketing' },
): Promise<CompanyTask> {
  return repo.create({
    team: partial.team,
    title: partial.title ?? '일',
    request: partial.request ?? '일을 해 주세요',
    source: partial.source ?? 'owner',
    status: partial.status ?? 'queued',
  });
}
