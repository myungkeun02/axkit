import type { OutgoingImage } from '../conversation/types.js';
import type { ConfirmAnswer, ConfirmPolicyConfig, Confirmer, Effect } from '../policy/types.js';
import type { AuditLog, Logger } from '../log/types.js';
import type { Tool, ToolCallContext, ToolExecutor, ToolOutcome, ToolRegistry } from './types.js';
import { needsConfirmation } from '../policy/confirm.js';
import type { KillState } from '../switches/kill.js';
import { isOutward } from '../switches/kill.js';
import type { AutonomyRule, AutonomyRules, AutonomyScope } from '../policy/autonomy.js';
import type { AutonomyTracker } from '../policy/promoter.js';
import type { TrackScope } from '../policy/promotion.js';
import { guardText } from '../text/data.js';
import { REMOVED } from '../text/injection.js';
import { runBounded } from './bounded-run.js';

/** The model's 육하원칙 line for the card; dropped whole when it carries an instruction aimed at the AI. */
function cardContext(why: string | undefined): { context?: string } {
  if (why === undefined) return {};
  const screened = guardText('tool_reason', why);
  return screened.includes(REMOVED) || screened.trim() === '' ? {} : { context: screened.slice(0, 300) };
}

// Long jobs (writing code, a delegated browser run) may ask for more, never more than this.
const MAX_TOOL_TIMEOUT_MS = 3 * 3_600_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const NO_GROUNDING: ToolCallContext = { grounding: [] };

interface ExecutorOptions {
  registry: ToolRegistry;
  confirmer: () => Confirmer | undefined;
  policy: ConfirmPolicyConfig;
  audit: AuditLog;
  log: Logger;
  timeoutMs?: number;
  /** The global stop; send, pay and delete tools are refused while it is on. */
  kill?: () => Promise<KillState>;
  /** "From now on, just do it" rules; without it every card is asked every time. */
  autonomy?: AutonomyRules;
  /** The default scope's wording for an exact repeat of `summary`. */
  rememberLabel?: (summary: string) => string;
  /** Told after an action ran under a rule, so the owner hears what was done without being asked. */
  onAuto?: (rule: AutonomyRule, summary: string) => void;
  /** Counts how the owner answers each scope's cards and how its actions end (자동 실행 승격). */
  tracker?: AutonomyTracker;
  /** Every finished action that changed something, with the line the owner would have seen on a card. */
  onDone?: (name: string, summary: string, effects: readonly Effect[], auto: boolean) => void;
}

function dedupe(effects: readonly Effect[]): Effect[] {
  return [...new Set(effects)];
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable]';
  }
}

export class PolicyToolExecutor implements ToolExecutor {
  private readonly timeoutMs: number;

  constructor(private readonly opts: ExecutorOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async execute(name: string, rawInput: unknown, call: ToolCallContext = NO_GROUNDING): Promise<ToolOutcome> {
    const tool = this.opts.registry.get(name);
    if (tool === undefined) {
      await this.record(name, 'failed', []);
      return { status: 'failed', error: `Unknown tool: ${name}` };
    }

    const parsed = tool.input.safeParse(rawInput);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((issue) => {
        const path = issue.path.map((part) => String(part)).join('.');
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
      });
      await this.record(name, 'invalid_input', []);
      return { status: 'invalid_input', issues };
    }

    const input = parsed.data;
    const effects = dedupe([...tool.effects, ...(tool.effectsFor?.(input) ?? [])]);

    const rejection = this.safely(() => tool.reject?.(input, call), 'evidence check failed');
    if (rejection !== undefined) {
      await this.record(name, 'rejected', effects);
      return { status: 'rejected', reason: rejection };
    }
    const stopped = await this.stopped(effects);
    if (stopped !== undefined) {
      await this.record(name, 'rejected', effects);
      return { status: 'rejected', reason: stopped };
    }
    // A failing uncertainty check counts as uncertain: asking is the safe side.
    const note = this.safely(() => tool.uncertainty?.(input, call), 'could not check certainty');

    const asks = note !== undefined || needsConfirmation(effects, this.opts.policy);
    const scope = asks && note === undefined ? this.scopeFor(tool, name, input, effects) : undefined;
    const found = scope !== undefined ? await this.opts.autonomy?.find(name, scope.key).catch(() => undefined) : undefined;
    // a paused rule is no rule: the card comes back until the owner turns it on again
    const rule = found?.paused === undefined ? found : undefined;
    const tracked: TrackScope | undefined =
      scope !== undefined
        ? { tool: name, scope: scope.key, label: scope.label, effects, ...(scope.detail !== undefined ? { detail: scope.detail } : {}), ...(scope.recipient !== undefined ? { recipient: scope.recipient } : {}) }
        : undefined;
    if (rule !== undefined) {
      await this.opts.autonomy?.used(rule.id).catch(() => undefined);
      await this.opts.audit.append({ at: new Date(), kind: 'tool.auto', subject: name, detail: { rule: rule.id, effects } }).catch(() => undefined);
    } else if (asks) {
      const confirmer = this.opts.confirmer();
      if (confirmer === undefined) {
        this.opts.log.warn('confirmation required but no confirmer is available', { tool: name });
        await this.record(name, 'denied', effects);
        return { status: 'denied' };
      }
      let answer: ConfirmAnswer;
      let typed = false;
      let cancelled = false;
      try {
        let images: readonly OutgoingImage[] | undefined;
        try {
          images = tool.images?.(input);
        } catch {
          images = undefined;
        }
        const ask = (signal?: AbortSignal): Promise<ConfirmAnswer> =>
          confirmer.confirm(
            {
              summary: this.summary(tool, name, input),
              effects,
              toolName: name,
              ...(note !== undefined ? { note } : {}),
              ...cardContext(call.why),
              ...(images !== undefined && images.length > 0 ? { images } : {}),
              ...(scope !== undefined && this.opts.autonomy !== undefined
                ? { remember: this.remember(name, scope) }
                : {}),
              report: (reported) => {
                typed = reported.text !== undefined;
              },
            },
            signal !== undefined ? { signal } : {},
          );
        // a turn waiting on the card gives up the conversation meanwhile; "취소해" in chat closes the card as a no
        answer =
          call.awaitOwner === undefined
            ? await ask()
            : await call.awaitOwner(async (signal) => {
                const given = await ask(signal);
                cancelled = signal.aborted;
                return given;
              }, this.summary(tool, name, input));
        if (cancelled) answer = 'denied';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.opts.log.error('confirmation failed', { tool: name, error: message });
        answer = 'denied';
      }
      if (tracked !== undefined && answer !== 'expired') {
        await this.opts.tracker?.answered(tracked, answer === 'approved' ? 'approved' : typed ? 'edited' : 'denied').catch(() => undefined);
      }
      if (answer !== 'approved') {
        const status = answer === 'expired' ? 'expired' : 'denied';
        await this.record(name, status, effects);
        return { status };
      }
    }

    const late = await this.stopped(effects);
    if (late !== undefined) {
      await this.record(name, 'rejected', effects);
      return { status: 'rejected', reason: late };
    }

    const limit = Math.min(tool.timeoutMs ?? this.timeoutMs, MAX_TOOL_TIMEOUT_MS);
    try {
      const output = await runBounded(name, limit, (signal) => tool.run(input, { log: this.opts.log, signal, call }));
      await this.record(name, 'done', effects);
      if (rule !== undefined) {
        try {
          this.opts.onAuto?.(rule, this.summary(tool, name, input));
        } catch {
          // telling the owner never changes the outcome
        }
      }
      if (tracked !== undefined) await this.opts.tracker?.finished(tracked, { ok: true, ...(rule !== undefined ? { rule } : {}) }).catch(() => undefined);
      if (effects.some((effect) => effect !== 'read')) {
        try {
          this.opts.onDone?.(name, this.summary(tool, name, input), effects, rule !== undefined);
        } catch {
          // history is best effort
        }
      }
      return { status: 'done', output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.opts.log.warn('tool failed', { tool: name, error: message });
      await this.record(name, 'failed', effects);
      if (tracked !== undefined) await this.opts.tracker?.finished(tracked, { ok: false, ...(rule !== undefined ? { rule } : {}) }).catch(() => undefined);
      return { status: 'failed', error: message };
    }
  }

  /** Checked before asking and again right before acting, so a stop pressed while a card waits still holds. */
  private async stopped(effects: readonly Effect[]): Promise<string | undefined> {
    if (this.opts.kill === undefined || !isOutward(effects)) return undefined;
    let state: KillState;
    try {
      state = await this.opts.kill();
    } catch {
      state = { stopped: true, reason: 'could not read the stop switch' };
    }
    if (!state.stopped) return undefined;
    return `Everything outward is stopped${state.reason !== undefined ? ` (${state.reason})` : ''}; nothing was sent, paid or deleted.`;
  }

  /** The tool's own scope, or for read/write/send tools only, "exactly this action again". */
  private scopeFor(tool: Tool<unknown, unknown>, name: string, input: unknown, effects: readonly Effect[]): AutonomyScope | undefined {
    const own = this.safelyValue(() => tool.autonomyScope?.(input));
    if (own !== undefined) return own;
    if (effects.includes('pay') || effects.includes('delete') || effects.includes('system') || this.opts.rememberLabel === undefined) return undefined;
    const summary = this.summary(tool, name, input);
    return { key: `same:${summary}`, label: this.opts.rememberLabel(summary) };
  }

  private remember(name: string, scope: AutonomyScope): { label: string; detail?: string; accept(): Promise<void> } {
    const rules = this.opts.autonomy;
    return {
      label: scope.label,
      ...(scope.detail !== undefined ? { detail: scope.detail } : {}),
      accept: async () => {
        if (rules === undefined) return;
        const rule = await rules.add(name, scope);
        await this.opts.audit.append({ at: new Date(), kind: 'autonomy.add', subject: name, detail: { rule: rule.id } }).catch(() => undefined);
      },
    };
  }

  private safelyValue<T>(read: () => T | undefined): T | undefined {
    try {
      return read();
    } catch {
      return undefined;
    }
  }

  private safely(check: () => string | undefined, fallback: string): string | undefined {
    try {
      return check();
    } catch {
      return fallback;
    }
  }

  private summary(tool: Tool<unknown, unknown>, name: string, input: unknown): string {
    try {
      return tool.describe?.(input) ?? `${name} ${safeJson(input)}`;
    } catch {
      return `${name} ${safeJson(input)}`;
    }
  }

  private async record(subject: string, status: ToolOutcome['status'], effects: readonly Effect[]): Promise<void> {
    try {
      await this.opts.audit.append({ at: new Date(), kind: 'tool', subject, detail: { status, effects } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.opts.log.error('audit append failed', { subject, error: message });
    }
  }
}
