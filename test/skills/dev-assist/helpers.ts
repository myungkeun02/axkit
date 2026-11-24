import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmGateway } from '../../../src/core/llm/types.js';
import type { ProcessRunner, RunOptions, RunResult } from '../../../src/core/process/types.js';
import { devAssistSkill } from '../../../src/skills/dev-assist/plugin.js';
import type { Job } from '../../../src/skills/dev-assist/types.js';
import type { FinishedTask } from '../../../src/skills/dev-assist/run-task.js';
import type { Notice, NoticeResult, Notifier } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { FakeConfirmer } from '../../support/context.js';
import { createTestContext } from '../../support/context.js';
import type { TestContext } from '../../support/context.js';

export const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
export const REPO = { slug: 'owner/example', path: '/repos/example' };
export const NOW = new Date('2026-11-17T09:00:00+09:00');

export interface Call {
  cmd: string;
  args: readonly string[];
  opts: RunOptions;
}

type Answer = Partial<RunResult>;
type Handler = (
  cmd: string,
  args: readonly string[],
  opts: RunOptions,
) => Answer | undefined | Promise<Answer | undefined>;

/** Records argv, env, cwd and stdin. Handlers let a test answer the git/test calls it cares about. */
export class FakeRunner {
  readonly calls: Call[] = [];
  private readonly handlers: Handler[] = [];

  on(match: (cmd: string, args: readonly string[]) => boolean, handler: Handler | Answer): this {
    const answer: Handler = typeof handler === 'function' ? handler : () => handler;
    this.handlers.push((cmd, args, opts) => (match(cmd, args) ? answer(cmd, args, opts) : undefined));
    return this;
  }

  readonly run: ProcessRunner = async (cmd, args, opts) => {
    this.calls.push({ cmd, args, opts });
    for (const handler of this.handlers) {
      const answer = await handler(cmd, args, opts);
      if (answer !== undefined) {
        return {
          code: answer.code ?? 0,
          stdout: answer.stdout ?? '',
          stderr: answer.stderr ?? '',
          timedOut: answer.timedOut ?? false,
        };
      }
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };

  matching(fragment: string): Call[] {
    return this.calls.filter((call) => [call.cmd, ...call.args].join(' ').includes(fragment));
  }

  allArgv(): string[] {
    return this.calls.flatMap((call) => [call.cmd, ...call.args]);
  }
}

function has(args: readonly string[], value: string): boolean {
  return args.includes(value);
}

export interface GitAnswers {
  changed?: readonly string[];
  diff?: string;
  diffStat?: string;
  sha?: string;
}

/** Answers `git status`, `git diff`, `git diff --stat` and `git rev-parse` like a checked-out worktree. */
export function fakeGit(runner: FakeRunner, answers: GitAnswers = {}): FakeRunner {
  const changed = answers.changed ?? [];
  const status = changed.length === 0 ? '' : `${changed.map((path) => ` M ${path}`).join('\n')}\n`;
  runner.on((_cmd, args) => has(args, 'status') && has(args, '--porcelain'), { stdout: status });
  runner.on((_cmd, args) => has(args, 'diff') && has(args, '--stat'), {
    stdout: answers.diffStat ?? ' src/a.ts | 2 ++\n',
  });
  runner.on((_cmd, args) => has(args, 'diff'), { stdout: answers.diff ?? '' });
  runner.on((_cmd, args) => has(args, 'rev-parse'), { stdout: `${answers.sha ?? 'abc1234'}\n` });
  return runner;
}

export interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

export class FakeFetch {
  readonly calls: FetchCall[] = [];
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response> = () => json({});

  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    this.calls.push({ url, init: init ?? undefined });
    return this.handler(url, init ?? undefined);
  };

  posts(): FetchCall[] {
    return this.calls.filter((call) => call.init?.method === 'POST');
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

export function issue(number: number, title: string, body = '') {
  return { number, title, body, html_url: `https://github.com/${REPO.slug}/issues/${number}` };
}

export interface SetupDevOptions {
  runner?: FakeRunner;
  fetchImpl?: FakeFetch;
  llm?: LlmGateway;
  coder?: 'claude-cli' | 'codex-cli' | 'llm';
  /** null means "no GitHub token stored". */
  token?: string | null;
  repos?: { slug: string; path: string; base?: string; test?: string[]; testTimeoutSeconds?: number }[];
  jobs?: Job[];
  workDir?: string;
  confirmer?: FakeConfirmer;
  language?: string;
  capabilities?: Record<string, unknown>;
}

export class RecordingNotifier implements Notifier {
  readonly notices: Notice[] = [];
  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return 'sent';
  }
}

export interface DevTestContext extends TestContext {
  runner: FakeRunner;
  fetchImpl: FakeFetch;
  notifier: RecordingNotifier;
  finished: FinishedTask[];
  /** The next job to finish (or one that already finished and nobody waited for yet). */
  nextFinished(): Promise<FinishedTask>;
}

export async function setupDev(options: SetupDevOptions = {}): Promise<DevTestContext> {
  const runner = options.runner ?? new FakeRunner();
  const fetchImpl = options.fetchImpl ?? new FakeFetch();
  const notifier = new RecordingNotifier();
  const context = createTestContext({
    now: NOW,
    capabilities: { [Contracts.notifier.id]: notifier, ...(options.capabilities ?? {}) },
    ...(options.language !== undefined ? { assistant: { language: options.language } } : {}),
    ...(options.llm !== undefined ? { llm: options.llm } : {}),
    ...(options.confirmer !== undefined ? { confirmer: options.confirmer } : {}),
    config: {
      repos: options.repos ?? [{ slug: REPO.slug, path: REPO.path }],
      coder: options.coder ?? 'claude-cli',
    },
  });

  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) await context.secrets.set('github.token', token);
  if (options.jobs !== undefined) await context.kv.set('jobs', options.jobs);

  const finished: FinishedTask[] = [];
  const unclaimed: FinishedTask[] = [];
  const waiters: ((result: FinishedTask) => void)[] = [];
  await devAssistSkill({
    workDir: options.workDir ?? join(tmpdir(), 'ax-kit-dev-test', randomUUID()),
    run: runner.run,
    fetch: fetchImpl.fetch,
    onFinished: (result) => {
      finished.push(result);
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(result);
      else unclaimed.push(result);
    },
  }).setup(context.ctx);

  const nextFinished = (): Promise<FinishedTask> => {
    const ready = unclaimed.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve) => waiters.push(resolve));
  };
  return { ...context, runner, fetchImpl, notifier, finished, nextFinished };
}

export function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job_seed',
    repo: REPO.slug,
    branch: 'ax-kit/fix-the-thing-abc123',
    dir: '/work/job_seed',
    title: 'Fix the thing',
    request: 'Fix the thing',
    status: 'ready',
    diffStat: ' src/a.ts | 2 ++\n',
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

export async function storedJobs(context: DevTestContext): Promise<Job[]> {
  return (await context.kv.get<Job[]>('jobs')) ?? [];
}
