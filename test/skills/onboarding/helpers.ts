import type {
  FileEntry,
  FileSource,
  FolderScan,
  FolderScanner,
  FolderWalk,
  KnowledgeLine,
  KnowledgeWriter,
  OwnerReview,
  ProfileReader,
  RepoDetails,
  ReviewRequest,
  ScanResult,
} from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { Notice, NoticeResult, Notifier } from '../../../src/core/contracts/index.js';
import type { LlmGateway, LlmRequest, LlmResponse } from '../../../src/core/llm/types.js';
import type { SignalCollector } from '../../../src/skills/onboarding/signals.js';
import { SummaryCache } from '../../../src/skills/onboarding/cache.js';
import { readOnboardingConfig } from '../../../src/skills/onboarding/config.js';
import type { OnboardingConfig } from '../../../src/skills/onboarding/config.js';
import { onboardingTexts } from '../../../src/skills/onboarding/locale.js';
import { OnboardingRunner } from '../../../src/skills/onboarding/runner.js';
import type { ProgressEvent } from '../../../src/skills/onboarding/runner.js';
import { RunStateStore } from '../../../src/skills/onboarding/state.js';
import { createTestContext } from '../../support/context.js';
import { flush } from '../../core/helpers.js';

export const NOW = new Date('2026-11-17T09:00:00+09:00');
export const DAY_MS = 24 * 60 * 60 * 1000;

export function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

export class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];

  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return 'sent';
  }
}

export class FakeFolderScan implements FolderScan {
  walkData: FolderWalk;
  readonly bodies = new Map<string, string>();
  readonly repos = new Map<string, RepoDetails>();

  constructor(walkData: FolderWalk) {
    this.walkData = walkData;
  }

  async walk(signal?: AbortSignal): Promise<FolderWalk> {
    if (signal?.aborted === true) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    return this.walkData;
  }

  async excerpt(id: string, maxBytes: number): Promise<string> {
    void maxBytes;
    return this.bodies.get(id) ?? '';
  }

  async repo(id: string): Promise<RepoDetails> {
    return this.repos.get(id) ?? { commits: [], languages: [] };
  }
}

export class FakeFolderScanner implements FolderScanner {
  readonly opened: (readonly string[])[] = [];

  constructor(readonly scan: FakeFolderScan) {}

  open(folders: readonly string[]): FolderScan {
    this.opened.push([...folders]);
    return this.scan;
  }
}

export class FakeDrive implements FileSource {
  readonly label = 'drive';
  readonly bodies = new Map<string, string>();
  entries: FileEntry[];

  constructor(entries: FileEntry[] = []) {
    this.entries = entries;
  }

  async list(opts: { modifiedAfter?: Date; limit: number }): Promise<FileEntry[]> {
    void opts;
    return this.entries;
  }

  async recent(opts: { modifiedAfter?: Date; limit: number }): Promise<FileEntry[]> {
    return this.entries.slice(0, opts.limit);
  }

  async readText(id: string, maxBytes: number): Promise<string> {
    void maxBytes;
    return this.bodies.get(id) ?? '';
  }
}

export class FakeKnowledgeWriter implements KnowledgeWriter {
  readonly results: ScanResult[] = [];
  readonly corrections: { id: string; text?: string }[] = [];

  async replaceScan(result: ScanResult): Promise<{ added: number; retired: number }> {
    this.results.push(result);
    return { added: result.profile.length + result.projects.length, retired: 0 };
  }

  async correct(id: string, text: string | undefined): Promise<void> {
    this.corrections.push(text === undefined ? { id } : { id, text });
  }
}

export class FakeProfile implements ProfileReader {
  constructor(private readonly lines: readonly { id: string; text: string }[] = []) {}

  async summary(maxChars: number): Promise<string | undefined> {
    return this.lines.map((line) => line.text).join(' ').slice(0, maxChars);
  }

  async reviewLines(): Promise<readonly { id: string; text: string }[]> {
    return this.lines;
  }
}

export class FakeOwnerReview implements OwnerReview {
  readonly requests: ReviewRequest[] = [];

  async start(request: ReviewRequest): Promise<void> {
    this.requests.push(request);
  }
}

export type LlmBehavior = (request: LlmRequest, index: number) => string | Promise<string>;

export class BehaviorLlm implements LlmGateway {
  readonly requests: LlmRequest[] = [];
  behavior: LlmBehavior;

  constructor(behavior: LlmBehavior) {
    this.behavior = behavior;
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    this.requests.push(request);
    const text = await this.behavior(request, this.requests.length - 1);
    return { text, providerId: 'fake', model: 'fake', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }

  ofPurpose(purpose: string): LlmRequest[] {
    return this.requests.filter((request) => request.purpose === purpose);
  }
}

export function makeFile(
  id: string,
  path: string,
  ext: string,
  modifiedAt: string,
  size = 100,
  readable = true,
): FolderWalk['files'][number] {
  return { id, path, name: path.split('/').at(-1) ?? id, ext, size, modifiedAt, readable };
}

export function makeRepo(id: string, path: string, modifiedAt: string): FolderWalk['repos'][number] {
  return { id, path, name: path.split('/').at(-1) ?? id, modifiedAt };
}

export function makeWalk(
  files: FolderWalk['files'][number][] = [],
  repos: FolderWalk['repos'][number][] = [],
): FolderWalk {
  return { files, repos, truncated: false };
}

export function summaryJson(summary: string, keywords: string[] = ['kw']): string {
  return JSON.stringify({ summary, keywords });
}

export function profileJson(input: {
  profile?: { topic: 'role' | 'org' | 'interest' | 'other'; key: string; text: string; sources: string[] }[];
  projects?: {
    name: string;
    purpose?: string;
    status?: string;
    recent?: string;
    people?: string[];
    sources: string[];
  }[];
}): string {
  return JSON.stringify({
    profile: input.profile ?? [],
    projects: (input.projects ?? []).map((project) => ({
      name: project.name,
      purpose: project.purpose ?? '',
      status: project.status ?? '',
      recent: project.recent ?? '',
      people: project.people ?? [],
      sources: project.sources,
    })),
  });
}

export function sourceLabels(lines: readonly KnowledgeLine[]): string[] {
  return lines.flatMap((line) => line.sources);
}

export async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return;
    await flush();
  }
  if (!predicate()) throw new Error('condition was not met');
}

export interface RunnerOptions {
  llm: LlmGateway;
  walk?: FolderWalk;
  scan?: FakeFolderScan;
  drive?: FakeDrive;
  capabilities?: Record<string, unknown>;
  config?: Record<string, unknown>;
  collector?: SignalCollector;
  collectors?: SignalCollector[];
}

export interface RunnerSetup {
  context: ReturnType<typeof createTestContext>;
  config: OnboardingConfig;
  state: RunStateStore;
  cache: SummaryCache;
  runner: OnboardingRunner;
  progress: ProgressEvent[];
  scan: FakeFolderScan;
}

export async function setupRunner(options: RunnerOptions): Promise<RunnerSetup> {
  const scan = options.scan ?? new FakeFolderScan(options.walk ?? makeWalk());
  const scanner = new FakeFolderScanner(scan);
  const capabilities: Record<string, unknown> = {
    [Contracts.folderScan.id]: scanner,
    ...(options.drive !== undefined ? { [Contracts.filesDrive.id]: options.drive } : {}),
    ...(options.capabilities ?? {}),
  };
  const context = createTestContext({
    now: NOW,
    llm: options.llm,
    config: { enabled: true, folders: ['~/work'], autoStart: false, ...(options.config ?? {}) },
    capabilities,
  });
  const config = readOnboardingConfig(context.ctx);
  const state = new RunStateStore(context.kv);
  await state.load();
  const cache = new SummaryCache(context.kv);
  await cache.load();
  const progress: ProgressEvent[] = [];
  const runner = new OnboardingRunner({
    ctx: context.ctx,
    config,
    state,
    cache,
    texts: onboardingTexts('ko'),
    collectors: options.collectors ?? (options.collector === undefined ? [] : [options.collector]),
    onProgress: (event) => progress.push(event),
  });
  return { context, config, state, cache, runner, progress, scan };
}

export function asCapabilities(entries: { cap: string; value: unknown }[]): Record<string, unknown> {
  return Object.fromEntries(entries.map((entry) => [entry.cap, entry.value]));
}
