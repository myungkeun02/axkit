import type { WebAgent, WebRunInput, WebRunResult } from '../../core/contracts/web-agent.js';
import type { ProcessRunner } from '../../core/process/types.js';

/**
 * The Aside CLI as the assistant's hands on the web: `aside --json "<task>"` runs a browser agent in the owner's own
 * signed-in Aside browser (their logins, their sites) and prints `{session:{id}, outcome, answer, error}`.
 * The rules travel inside every prompt, and the caller's policy (cards) decides before `do` is ever called.
 */
const LOOK_RULES =
  'LOOK ONLY. Do not click submit, buy, order, book, send, post, delete, save or change any setting. Do not type into forms except search boxes. ' +
  'Report what you found in plain Korean, briefly. If a login is needed and you are not signed in, stop and say LOGIN_NEEDED.';
const DO_RULES =
  'The owner approved exactly this task. Do only this. Before any final payment or money transfer, stop and say PAYMENT_STEP with what is in the cart and the total. ' +
  'If a login is needed and you are not signed in, stop and say LOGIN_NEEDED. Report what you did in plain Korean, briefly.';

export interface AsideOptions {
  command: string;
  run: ProcessRunner;
  account?: string;
  effort?: string;
  defaultTimeoutMinutes: number;
}

interface AsideJson {
  session?: { id?: unknown };
  outcome?: unknown;
  answer?: unknown;
  error?: unknown;
}

export function parseAside(stdout: string): AsideJson | undefined {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      return JSON.parse(text) as AsideJson;
    } catch {
      continue;
    }
  }
  return undefined;
}

export function promptFor(input: WebRunInput): string {
  const site = input.site !== undefined && input.site !== '' ? `Site: ${/^https?:\/\//.test(input.site) ? input.site : `https://${input.site}`}\n` : '';
  return `${input.mode === 'look' ? LOOK_RULES : DO_RULES}\n${site}Task: ${input.task}`;
}

export class AsideWebAgent implements WebAgent {
  readonly label = 'Aside';

  constructor(private readonly opts: AsideOptions) {}

  async run(input: WebRunInput, signal?: AbortSignal): Promise<WebRunResult> {
    const minutes = Math.max(1, Math.min(30, input.timeoutMinutes ?? this.opts.defaultTimeoutMinutes));
    const args = [
      '--json',
      '--timeout', `${minutes}m`,
      ...(this.opts.account !== undefined ? ['--account', this.opts.account] : []),
      ...(this.opts.effort !== undefined ? ['--effort', this.opts.effort] : []),
      promptFor(input),
    ];
    const result = await this.opts.run(this.opts.command, args, { timeoutMs: (minutes + 1) * 60_000, ...(signal !== undefined ? { signal } : {}) });
    if (result.timedOut) return { ok: false, answer: '', stopped: 'timeout' };
    const parsed = parseAside(result.stdout);
    if (parsed === undefined) return { ok: false, answer: '', stopped: 'error' };
    const answer = typeof parsed.answer === 'string' ? parsed.answer.slice(0, 4000) : '';
    const session = typeof parsed.session?.id === 'string' ? parsed.session.id : undefined;
    const stopped = /LOGIN_NEEDED/.test(answer) ? 'login' : /PAYMENT_STEP/.test(answer) ? 'payment' : parsed.outcome !== 'completed' ? (parsed.outcome === 'timeout' ? 'timeout' : 'error') : undefined;
    return { ok: stopped === undefined, answer, ...(session !== undefined ? { session } : {}), ...(stopped !== undefined ? { stopped } : {}) };
  }
}
