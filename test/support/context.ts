import type { Capability, PluginContext } from '../../src/core/plugin/types.js';
import type { MessageHandler } from '../../src/core/conversation/types.js';
import type { Job, Scheduler } from '../../src/core/scheduler/types.js';
import type { ChatMessage, LlmGateway, LlmRequest, LlmResponse } from '../../src/core/llm/types.js';
import type { ConfirmAnswer, ConfirmPolicyConfig, ConfirmRequest, Confirmer } from '../../src/core/policy/types.js';
import type { Tool } from '../../src/core/tools/types.js';
import { InMemoryEventBus } from '../../src/core/events/bus.js';
import { InMemoryToolRegistry } from '../../src/core/tools/registry.js';
import { PolicyToolExecutor } from '../../src/core/tools/executor.js';
import { RegistryToolbox } from '../../src/core/tools/toolbox.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { MemoryAuditLog, silentLogger } from '../../src/core/log/console-logger.js';
import { FakeClock, MapKeyValueStore } from '../core/helpers.js';

/** Records jobs instead of arming timers; tests call `run(name)`. */
export class FakeScheduler implements Scheduler {
  readonly jobs = new Map<string, Job>();
  add(job: Job): void {
    if (this.jobs.has(job.name)) throw new Error(`Duplicate job name: ${job.name}`);
    this.jobs.set(job.name, job);
  }
  start(): void {}
  async stop(): Promise<void> {}
  nextRun(): Date | undefined {
    return undefined;
  }
  async run(name: string, now = new Date()): Promise<void> {
    const job = this.jobs.get(name);
    if (job === undefined) throw new Error(`No job ${name}`);
    await job.run(now);
  }
}

/** Answers LLM calls from a script, in order. Each entry is the response text or a function of the request. */
export class ScriptedLlm implements LlmGateway {
  readonly requests: LlmRequest[] = [];
  constructor(private readonly script: (string | ((req: LlmRequest) => string))[] = []) {}
  push(entry: string | ((req: LlmRequest) => string)): void {
    this.script.push(entry);
  }
  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const next = this.script.shift();
    if (next === undefined) throw new Error('ScriptedLlm: no scripted response left');
    const text = typeof next === 'string' ? next : next(request);
    return { text, providerId: 'fake', model: 'fake', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
  lastMessages(): readonly ChatMessage[] {
    return this.requests.at(-1)?.messages ?? [];
  }
}

export class FakeConfirmer implements Confirmer {
  readonly requests: ConfirmRequest[] = [];
  constructor(public answer: ConfirmAnswer = 'approved') {}
  async confirm(request: ConfirmRequest): Promise<ConfirmAnswer> {
    this.requests.push(request);
    return this.answer;
  }
}

export interface TestContextOptions {
  config?: Record<string, unknown>;
  assistant?: Partial<PluginContext['assistant']>;
  now?: Date;
  llm?: LlmGateway;
  policy?: ConfirmPolicyConfig;
  confirmer?: Confirmer;
  capabilities?: Record<string, unknown>;
}

export interface TestContext {
  ctx: PluginContext;
  clock: FakeClock;
  scheduler: FakeScheduler;
  secrets: MemorySecretStore;
  kv: MapKeyValueStore;
  registry: InMemoryToolRegistry;
  confirmer: FakeConfirmer | Confirmer;
  audit: MemoryAuditLog;
  handlers: MessageHandler[];
  provided: Map<string, unknown>;
  bus: InMemoryEventBus;
}

/** A PluginContext with real policy/tool plumbing and fakes for everything that touches the world. */
export function createTestContext(opts: TestContextOptions = {}): TestContext {
  const clock = new FakeClock(opts.now ?? new Date('2026-11-17T09:00:00+09:00'));
  const scheduler = new FakeScheduler();
  const secrets = new MemorySecretStore();
  const kv = new MapKeyValueStore();
  const registry = new InMemoryToolRegistry();
  const audit = new MemoryAuditLog();
  const confirmer = opts.confirmer ?? new FakeConfirmer();
  const handlers: MessageHandler[] = [];
  const provided = new Map<string, unknown>(Object.entries(opts.capabilities ?? {}));
  const bus = new InMemoryEventBus(silentLogger);
  const executor = new PolicyToolExecutor({
    registry,
    confirmer: () => confirmer,
    policy: opts.policy ?? { confirmWrites: false, expiresMinutes: 30 },
    audit,
    log: silentLogger,
  });
  const ctx: PluginContext = {
    config: { enabled: true, ...(opts.config ?? {}) },
    assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul', tone: 'polite', ...(opts.assistant ?? {}) },
    secrets,
    bus,
    scheduler,
    clock,
    llm: opts.llm ?? new ScriptedLlm(),
    log: silentLogger,
    kv,
    registerTool: <I, O>(tool: Tool<I, O>) => registry.register(tool),
    tools: new RegistryToolbox(registry, executor),
    registerHandler: (handler) => {
      handlers.push(handler);
    },
    provide: <T>(cap: Capability<T>, impl: T) => {
      if (provided.has(cap.id)) throw new Error(`Capability already provided: ${cap.id}`);
      provided.set(cap.id, impl);
    },
    use: <T>(cap: Capability<T>): T => {
      if (!provided.has(cap.id)) throw new Error(`Capability not available: ${cap.id}`);
      return provided.get(cap.id) as T;
    },
    tryUse: <T>(cap: Capability<T>): T | undefined => provided.get(cap.id) as T | undefined,
  };
  return { ctx, clock, scheduler, secrets, kv, registry, confirmer, audit, handlers, provided, bus };
}
