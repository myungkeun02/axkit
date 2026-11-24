import type {
  BrowserAgent,
  BrowserRunResult,
  BrowserTask,
  HandoffReason,
} from '../../core/contracts/index.js';
import type { ProcessRunner, RunResult } from '../../core/process/types.js';
import { taskPrompt } from './prompt.js';
import { isHttpUrl } from './url.js';

const RESULT_TAIL_CHARS = 3000;
const STDERR_TAIL_CHARS = 500;
const READ_GOAL = 'Open this page and report its visible text without clicking anything.';
const REASONS: readonly HandoffReason[] = ['login', 'payment', 'consent', 'captcha', 'other'];

export interface CliBrowserAgentOptions {
  run: ProcessRunner;
  command: string;
  args: readonly string[];
  timeoutMs: number;
  label?: string;
}

interface ParsedHandoff {
  reason: HandoffReason;
  url?: string;
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(value.length - limit);
}

function isReason(value: string): value is HandoffReason {
  return (REASONS as readonly string[]).includes(value);
}

function parseHandoff(stdout: string): ParsedHandoff | undefined {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('HANDOFF:')) continue;
    const tokens = line.slice('HANDOFF:'.length).trim().split(/\s+/);
    const token = (tokens[0] ?? '').toLowerCase();
    const reason: HandoffReason = isReason(token) ? token : 'other';
    const url = tokens[1];
    return { reason, ...(url !== undefined && url !== '' ? { url } : {}) };
  }
  return undefined;
}

function parseResult(stdout: string): string | undefined {
  const found: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('RESULT:')) continue;
    const text = line.slice('RESULT:'.length).trim();
    if (text !== '') found.push(text);
  }
  return found.length === 0 ? undefined : found.join('\n');
}

function summaryOf(stdout: string): string {
  return parseResult(stdout) ?? tail(stdout.trim(), RESULT_TAIL_CHARS);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Adapter for any browser-agent CLI the owner already runs. Prompts go on stdin unless `{prompt}` is an arg. */
export class CliBrowserAgent implements BrowserAgent {
  readonly label: string;
  private readonly runner: ProcessRunner;
  private readonly command: string;
  private readonly args: readonly string[];
  private readonly timeoutMs: number;

  constructor(options: CliBrowserAgentOptions) {
    this.runner = options.run;
    this.command = options.command;
    this.args = options.args;
    this.timeoutMs = options.timeoutMs;
    this.label = options.label ?? options.command;
  }

  async read(url: string, signal?: AbortSignal): Promise<BrowserRunResult> {
    if (!isHttpUrl(url)) {
      return { status: 'failed', summary: 'Only http and https addresses are supported.' };
    }
    return this.run({ goal: READ_GOAL, startUrl: url }, signal);
  }

  async run(task: BrowserTask, signal?: AbortSignal): Promise<BrowserRunResult> {
    let result: RunResult;
    try {
      result = await this.execute(task, signal);
    } catch (error) {
      return { status: 'failed', summary: `Could not start the browser agent: ${messageOf(error)}` };
    }

    const stderr = tail(result.stderr.trim(), STDERR_TAIL_CHARS);
    if (result.timedOut) {
      return { status: 'failed', summary: stderr === '' ? 'The browser agent timed out.' : stderr };
    }
    if (result.code !== 0) {
      return {
        status: 'failed',
        summary: stderr === '' ? `The browser agent exited with code ${result.code}.` : stderr,
      };
    }

    const handoff = parseHandoff(result.stdout);
    const summary = summaryOf(result.stdout);
    if (handoff !== undefined) {
      return {
        status: 'needs_human',
        summary,
        ...(handoff.url !== undefined ? { url: handoff.url } : {}),
        handoff,
      };
    }
    return { status: 'done', summary };
  }

  async openForHuman(url: string): Promise<void> {
    if (!isHttpUrl(url)) throw new Error('Only http and https addresses are supported.');
    const result = await this.runner('open', [url], { timeoutMs: this.timeoutMs });
    if (result.timedOut || result.code !== 0) throw new Error('Could not open the page on this Mac.');
  }

  private execute(task: BrowserTask, signal: AbortSignal | undefined): Promise<RunResult> {
    const prompt = taskPrompt(task);
    const usesArg = this.args.includes('{prompt}');
    const args = usesArg ? this.args.map((arg) => (arg === '{prompt}' ? prompt : arg)) : this.args;
    return this.runner(this.command, args, {
      timeoutMs: this.timeoutMs,
      ...(usesArg ? {} : { input: prompt }),
      ...(signal !== undefined ? { signal } : {}),
    });
  }
}
