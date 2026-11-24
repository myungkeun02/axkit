import { z } from 'zod';
import type { LlmGateway } from '../../../core/llm/types.js';
import { detectHandoff } from '../handoff.js';
import { judgeAction } from './policy.js';
import type { PolicyContext } from './policy.js';
import { FORMAT_RETRY, SYSTEM_PROMPT, turnPrompt } from './prompt.js';
import { resolveAction } from './snapshot.js';
import { Decision, DEFAULT_LIMITS } from './types.js';
import type { BrowserAction, Driver, HarnessLimits, HarnessResult, Observation, StopReason, TraceStep } from './types.js';

const DECISION_SCHEMA = z.toJSONSchema(Decision) as Record<string, unknown>;
delete DECISION_SCHEMA.$schema;

export interface HarnessOptions {
  driver: Driver;
  llm: LlmGateway;
  goal: string;
  startUrl: string;
  policy: PolicyContext;
  limits?: Partial<HarnessLimits>;
  signal?: AbortSignal;
  now?: () => number;
  /** Each finished step, for a run log the owner can read and evals can replay. */
  onStep?: (step: TraceStep) => void;
  /**
   * Asked once the run has stopped: true means the caller took the page over (a handoff kept for the owner), so the
   * driver is not closed here.
   */
  keepOpen?: (result: HarnessResult) => boolean;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The quote must really be on the page (text or an element name), so "done" cannot be made up. */
export function evidenceOnPage(evidence: string, observation: Observation): boolean {
  const quote = normalize(evidence);
  if (quote.length < 2) return false;
  const haystack = normalize([observation.title, observation.text, ...observation.elements.map((e) => e.name)].join(' '));
  return haystack.includes(quote);
}

function fingerprint(text: string): string {
  let hash = 2166136261;
  for (const char of normalize(text).slice(0, 4000)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 200) ?? 'unknown error';
}

/**
 * observe → decide → check → act, until done, a handoff, or a limit. The model proposes; code decides what may run.
 * Limits: actions, turns, wall clock (a model call needs `minModelMs` left), refused proposals, failed actions in a
 * row, and the same action on the same page repeated (warned at `repeatWarn`, stopped at twice that).
 */
export async function runHarness(opts: HarnessOptions): Promise<HarnessResult> {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = opts.now ?? Date.now;
  const deadline = now() + limits.deadlineMs;
  const trace: TraceStep[] = [];
  const repeats = new Map<string, number>();
  let actions = 0;
  let turns = 0;
  let rejected = 0;
  let failedInRow = 0;
  let unverified = 0;
  let lastError: string | undefined;
  let url = opts.startUrl;

  const record = (step: TraceStep): void => {
    trace.push(step);
    opts.onStep?.(step);
  };
  let last: HarnessResult | undefined;
  const finish = (stop: StopReason, extra: Partial<HarnessResult> = {}): HarnessResult => {
    last = { stop, url, actions, turns, trace, ...extra };
    return last;
  };

  try {
    await opts.driver.start(opts.startUrl);
    while (true) {
      if (opts.signal?.aborted === true) return finish('cancelled');
      if (actions >= limits.maxActions) return finish('max_actions');
      if (turns >= limits.maxTurns) return finish('max_turns');
      if (deadline - now() < limits.minModelMs) return finish('deadline');
      turns += 1;

      const observation = await opts.driver.observe();
      url = observation.url;
      if (detectHandoff(observation.url, observation.text) === 'captcha') {
        record({ turn: turns, url, thought: '', outcome: 'handoff', note: 'captcha' });
        return finish('handoff', { handoff: { reason: 'captcha', note: 'The page asks to prove a person is there.' } });
      }

      const decision = await decide(opts, observation, trace, lastError, limits.maxActions - actions, deadline - now());
      if (decision === undefined) return finish('model_failed');
      lastError = undefined;

      if (decision.handoff !== null) {
        record({ turn: turns, url, thought: decision.thought, outcome: 'handoff', note: decision.handoff.note });
        return finish('handoff', { handoff: decision.handoff });
      }
      if (decision.done !== null) {
        if (evidenceOnPage(decision.done.evidence, observation) || unverified >= 1) {
          const verified = evidenceOnPage(decision.done.evidence, observation);
          record({ turn: turns, url, thought: decision.thought, outcome: verified ? 'done' : 'unverified_done' });
          return finish('done', { answer: verified ? decision.done.answer : `(not confirmed on the page) ${decision.done.answer}` });
        }
        unverified += 1;
        lastError = 'done.evidence is not on this page; copy the exact words from page_text, or keep working';
        record({ turn: turns, url, thought: decision.thought, outcome: 'rejected', note: 'evidence not on page' });
        continue;
      }
      const action = decision.action;
      if (action === null) {
        lastError = 'return an action, done or handoff';
        if (++rejected >= limits.maxRejected) return finish('rejected_actions');
        continue;
      }

      const refusal = check(action, observation, opts.policy, repeats);
      if (refusal.kind === 'handoff') {
        record({ turn: turns, url, thought: decision.thought, action, outcome: 'handoff', note: refusal.note });
        return finish('handoff', {
          handoff: { reason: refusal.reason, note: refusal.note, ...(refusal.button !== undefined ? { button: refusal.button } : {}) },
        });
      }
      if (refusal.kind === 'stuck') {
        record({ turn: turns, url, thought: decision.thought, action, outcome: 'rejected', note: 'repeated without progress' });
        return finish('stuck');
      }
      if (refusal.kind === 'reject') {
        lastError = refusal.error;
        record({ turn: turns, url, thought: decision.thought, action, outcome: 'rejected', note: refusal.error });
        if (++rejected >= limits.maxRejected) return finish('rejected_actions');
        continue;
      }
      if (refusal.kind === 'warn') lastError = refusal.error;
      rejected = 0;

      actions += 1;
      try {
        await opts.driver.act(action, refusal.element);
        failedInRow = 0;
        record({ turn: turns, url, thought: decision.thought, action, outcome: 'acted' });
      } catch (error) {
        const message = errorText(error);
        lastError = `${JSON.stringify(action)} failed: ${message}`;
        record({ turn: turns, url, thought: decision.thought, action, outcome: 'failed', note: message });
        if (++failedInRow >= limits.maxFailedInRow) return finish('failed_actions');
      }
    }
  } finally {
    const kept = last !== undefined && opts.keepOpen?.(last) === true;
    if (!kept) await opts.driver.close().catch(() => undefined);
  }

  function check(
    action: BrowserAction,
    observation: Observation,
    policy: PolicyContext,
    seen: Map<string, number>,
  ):
    | { kind: 'ok' | 'warn'; element?: Observation['elements'][number]; error?: string }
    | { kind: 'reject'; error: string }
    | { kind: 'handoff'; reason: NonNullable<HarnessResult['handoff']>['reason']; note: string; button?: string }
    | { kind: 'stuck' } {
    const resolved = resolveAction(action, observation.elements);
    if (!resolved.ok) return { kind: 'reject', error: resolved.error };
    const verdict = judgeAction(action, resolved.element, policy);
    if (verdict.kind === 'reject') return verdict;
    if (verdict.kind === 'handoff') return verdict;
    // same address, same visible content, same action: a single-page app whose content changed is not a repeat
    const key = `${observation.url}\u0000${fingerprint(observation.text)}\u0000${JSON.stringify(action)}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    if (count >= limits.repeatWarn * 2) return { kind: 'stuck' };
    if (count >= limits.repeatWarn) {
      return { kind: 'warn', ...(resolved.element !== undefined ? { element: resolved.element } : {}), error: `this exact action was already tried ${count - 1} times here without progress; try something else or hand off` };
    }
    return { kind: 'ok', ...(resolved.element !== undefined ? { element: resolved.element } : {}) };
  }
}

async function decide(
  opts: HarnessOptions,
  observation: Observation,
  steps: readonly TraceStep[],
  lastError: string | undefined,
  actionsLeft: number,
  msLeft: number,
): Promise<Decision | undefined> {
  const prompt = turnPrompt({
    goal: opts.goal,
    observation,
    steps,
    ...(lastError !== undefined ? { lastError } : {}),
    actionsLeft,
    secondsLeft: Math.max(0, Math.round(msLeft / 1000)),
  });
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: prompt },
  ];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let text: string;
    try {
      const response = await opts.llm.complete({
        purpose: 'browser.agent',
        tier: 'standard',
        // pages of the owner's own accounts carry personal data
        sensitivity: 'sensitive',
        messages: attempt === 0 ? messages : [...messages, { role: 'user', content: FORMAT_RETRY }],
        jsonSchema: DECISION_SCHEMA,
        maxOutputTokens: 800,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
      text = response.text;
    } catch {
      return undefined;
    }
    const parsed = Decision.safeParse(parseJson(text));
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  try {
    return JSON.parse(start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed);
  } catch {
    return undefined;
  }
}
