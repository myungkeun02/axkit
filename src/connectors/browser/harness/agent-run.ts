import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserRunResult } from '../../../core/contracts/index.js';
import type { LlmGateway } from '../../../core/llm/types.js';
import { capRecap, renderRecap } from '../../../core/text/recap.js';
import { runHarness } from './loop.js';
import { allowedDomainsFor } from './policy.js';
import { PlaywrightDriver } from './playwright-driver.js';
import type { HarnessContext, HeldPage } from './playwright-driver.js';
import type { HarnessLimits, HarnessResult, TraceStep } from './types.js';

export interface AgentRunOptions {
  llm: LlmGateway;
  open: () => Promise<HarnessContext>;
  goal: string;
  startUrl: string;
  extraSites?: readonly string[];
  /** The one final button the owner approved for this run (see BrowserTask). */
  approvedCommit?: string;
  limits?: Partial<HarnessLimits>;
  signal?: AbortSignal;
  /** Directory for one JSONL trace per run; typed text is never written. */
  runsDir?: string;
  now?: () => Date;
  /** On a handoff the page stays open and goes here (with the address it stopped at) instead of being closed. */
  keep?: (held: HeldPage & { url: string }) => void;
}

const STOP_TEXT: Record<HarnessResult['stop'], string> = {
  done: 'finished',
  handoff: 'stopped for the owner',
  max_actions: 'used its action budget',
  max_turns: 'used its turn budget',
  deadline: 'ran out of time',
  stuck: 'kept repeating the same step',
  failed_actions: 'failed three actions in a row',
  rejected_actions: 'kept proposing steps that were refused',
  model_failed: 'could not get a usable answer from the model',
  cancelled: 'was cancelled',
  out_of_scope: 'left the task’s sites',
};

function redact(step: TraceStep): TraceStep {
  if (step.action?.kind !== 'fill') return step;
  return { ...step, action: { ...step.action, text: `[${step.action.text.length} chars]` } };
}

/** What the run did, as a recap the assistant (and the owner) can read. */
export function summarize(result: HarnessResult): string {
  const acted = result.trace.filter((step) => step.outcome === 'acted');
  const recap = capRecap({
    done: acted.slice(-6).map((step) => `${step.action?.kind ?? ''} on ${new URL(step.url).hostname}: ${step.thought}`),
    remaining:
      result.stop === 'done'
        ? []
        : [
            `The run ${STOP_TEXT[result.stop]} after ${result.actions} actions.`,
            // why the last step went wrong, so the owner hears a reason and not only "it failed"
            ...result.trace
              .filter((step) => step.outcome === 'failed' || step.outcome === 'rejected')
              .slice(-1)
              .map((step) => `Last problem: ${step.action?.kind ?? 'step'} on ${new URL(step.url).hostname}: ${(step.note ?? '').slice(0, 160)}`),
          ],
    unverified: result.answer?.startsWith('(not confirmed') === true ? ['The answer was not found word for word on the page.'] : [],
    nextAction: result.handoff !== undefined ? result.handoff.note : null,
  });
  return [result.answer ?? '', renderRecap(recap, 'en')].filter((part) => part !== '').join('\n\n');
}

export async function runBrowserAgent(opts: AgentRunOptions): Promise<BrowserRunResult> {
  const policy = {
    allowedDomains: allowedDomainsFor(opts.startUrl, opts.extraSites ?? []),
    ...(opts.approvedCommit !== undefined ? { approvedCommit: opts.approvedCommit } : {}),
  };
  const driver = new PlaywrightDriver({ open: opts.open, policy });
  const runFile =
    opts.runsDir !== undefined ? join(opts.runsDir, `${(opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')}.jsonl`) : undefined;
  if (opts.runsDir !== undefined) await mkdir(opts.runsDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
  const write = (line: unknown): void => {
    if (runFile !== undefined) void appendFile(runFile, `${JSON.stringify(line)}\n`, { mode: 0o600 }).catch(() => undefined);
  };
  write({ kind: 'start', startUrl: opts.startUrl, goalChars: opts.goal.length });

  let held: HeldPage | undefined;
  const keep = opts.keep;
  let result: HarnessResult;
  try {
    result = await runHarness({
      driver,
      llm: opts.llm,
      goal: opts.goal,
      startUrl: opts.startUrl,
      policy,
      ...(opts.limits !== undefined ? { limits: opts.limits } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      onStep: (step) => write({ kind: 'step', ...redact(step) }),
      ...(keep !== undefined
        ? {
            keepOpen: (stopped: HarnessResult) => {
              held = stopped.stop === 'handoff' && stopped.handoff !== undefined ? driver.detach() : undefined;
              return held !== undefined;
            },
          }
        : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    write({ kind: 'end', stop: 'error', error: message.slice(0, 200) });
    return { status: 'failed', summary: `The browser run failed: ${message}` };
  }
  write({ kind: 'end', stop: result.stop, actions: result.actions, turns: result.turns });
  if (held !== undefined) keep?.({ ...held, url: result.url });

  const summary = summarize(result);
  if (result.stop === 'done') return { status: 'done', summary, url: result.url };
  if (result.stop === 'handoff' && result.handoff !== undefined) {
    const { reason, button } = result.handoff;
    return { status: 'needs_human', summary, url: result.url, handoff: { reason, url: result.url, ...(button !== undefined ? { button } : {}) } };
  }
  return { status: 'failed', summary, url: result.url };
}
