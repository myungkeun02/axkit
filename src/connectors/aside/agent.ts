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
  'The owner approved exactly this task. Do only this: you may sign in, fill forms and submit them for it. ' +
  "To sign in, use only the login this browser already saved (its password manager or autofill); never type a password from the task or invent one. If there is no saved login or a verification code is asked, stop and say LOGIN_NEEDED. " +
  'Before the final payment or money transfer button, stop and say PAYMENT_STEP, then one line of JSON: {"items":"what is being bought, with counts","total":total in won as a number,"method":"the saved payment method shown"}. ' +
  'Report what you did in plain Korean, briefly.';
const payRules = (cart: { items: string; total: number; method?: string }): string =>
  `The owner approved paying exactly ${String(cart.total)} won for: ${cart.items}${cart.method !== undefined ? `, with ${cart.method}` : ''}. Finish this checkout now. ` +
  'Use only the payment method this browser or site already saved; never type card numbers, account numbers or passwords. If the site asks you to type card details, stop and say CARD_NEEDED. ' +
  'If the total or the items differ from what was approved, stop before paying and say TOTAL_CHANGED with the new total. ' +
  "If a login is needed, use only the browser's saved login, else stop and say LOGIN_NEEDED. When paid, report the order number and the amount paid in plain Korean.";

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
  const rules = input.mode === 'look' ? LOOK_RULES : input.mode === 'pay' && input.payment !== undefined ? payRules(input.payment) : DO_RULES;
  return `${rules}\n${site}Task: ${input.task}`;
}

/** The JSON line after PAYMENT_STEP: what is in the cart and the total. */
export function cartIn(answer: string): { items: string; total: number; method?: string } | undefined {
  const after = answer.slice(answer.indexOf('PAYMENT_STEP'));
  const match = /\{[^{}]*\}/.exec(after);
  if (match === null) return undefined;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    const total = typeof raw.total === 'number' ? raw.total : typeof raw.total === 'string' ? Number(raw.total.replace(/[^\d.]/g, '')) : Number.NaN;
    const items = typeof raw.items === 'string' ? raw.items.trim().slice(0, 300) : '';
    if (!Number.isFinite(total) || total <= 0 || items === '') return undefined;
    const method = typeof raw.method === 'string' && raw.method.trim() !== '' ? raw.method.trim().slice(0, 60) : undefined;
    return { items, total: Math.round(total), ...(method !== undefined ? { method } : {}) };
  } catch {
    return undefined;
  }
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
    // a pay run that met a payment-step marker means it did not pay
    const stopped = /LOGIN_NEEDED/.test(answer)
      ? 'login'
      : /TOTAL_CHANGED/.test(answer)
        ? 'changed'
        : /CARD_NEEDED/.test(answer)
          ? 'card'
          : /PAYMENT_STEP/.test(answer)
            ? 'payment'
            : parsed.outcome !== 'completed'
              ? parsed.outcome === 'timeout' ? 'timeout' : 'error'
              : undefined;
    const cart = stopped === 'payment' ? cartIn(answer) : undefined;
    return { ok: stopped === undefined, answer, ...(session !== undefined ? { session } : {}), ...(stopped !== undefined ? { stopped } : {}), ...(cart !== undefined ? { cart } : {}) };
  }
}
