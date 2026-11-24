import type { BrowserAgent, BrowserLiveHub, BrowserRunResult, HandoffReason } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ConversationRef } from '../../core/conversation/types.js';
import type { ToolRunContext } from '../../core/tools/types.js';
import { browserTexts } from '../browser/locale.js';
import type { BackgroundTasks, StartedTask, TaskOutcome } from '../work/background.js';
import type { ErrandTexts } from './locale.js';
import { looksCommitted, reportDetails } from './report.js';
import type { ErrandKind, ErrandOutput } from './types.js';

const MAX_TEXT = 6000;

export interface ErrandDeps {
  ctx: PluginContext;
  agent: BrowserAgent;
  texts: ErrandTexts;
  /** Errands run here, off the conversation turn, in the same queue as browser tasks on this browser. */
  tasks: BackgroundTasks;
}

/** What one errand decided from the run: the owner-facing status and words, and where the owner takes over. */
export interface ErrandDecision {
  status: ErrandOutput['status'];
  notice: string;
  /** Hand the page to the owner (the app's browser screen) for this reason; undefined means nothing to press. */
  handTo?: HandoffReason;
  button?: string;
}

export interface ErrandRun {
  kind: ErrandKind;
  /** The work list's title, e.g. "기차표: 서울 → 부산 11/28". */
  title: string;
  timeoutMs: number;
  goal: string;
  startUrl: string;
  /** The one seat button the owner approved on this card. Never a payment button (the harness refuses those). */
  approvedCommit?: string;
  decide(result: BrowserRunResult, details: Record<string, string>): ErrandDecision;
}

/** The owner can take the page over in the app: a live-capable browser and the app channel are both there. */
function liveHub(ctx: PluginContext): BrowserLiveHub | undefined {
  const live = ctx.tryUse(Contracts.browserLive);
  return live !== undefined && ctx.tryUse(Contracts.appViews) !== undefined ? live : undefined;
}

/**
 * Runs one errand through the existing browser agent and its harness (which never pays, never presses a final
 * button and hands logins, captchas and consent to the owner), then turns the result into the owner's notice.
 */
export async function runErrand(
  deps: ErrandDeps,
  run: ErrandRun,
  signal: AbortSignal,
  conversation: ConversationRef | undefined,
): Promise<ErrandOutput> {
  const live = liveHub(deps.ctx);
  const result = await deps.agent.run(
    {
      goal: run.goal,
      startUrl: run.startUrl,
      ...(run.approvedCommit !== undefined ? { approvedCommit: run.approvedCommit } : {}),
      // the app takes over this exact page, filled fields included, instead of reloading it
      ...(live !== undefined ? { keepPage: true } : {}),
    },
    signal,
  );
  const text = result.summary.slice(0, MAX_TEXT);
  if (result.status !== 'done') deps.ctx.log.info('errands: browser run ended', { kind: run.kind, status: result.status, summary: text.slice(0, 300) });
  const details = reportDetails(text);
  const url = result.handoff?.url ?? result.url ?? run.startUrl;
  let decision = run.decide(result, details);
  if (run.approvedCommit === undefined && looksCommitted(text)) {
    decision = { ...decision, notice: `${deps.texts.committed}\n\n${decision.notice}` };
  }

  const base = { errand: run.kind, status: decision.status, text, details, committed: false as const, url };
  if (decision.handTo === undefined) return { ...base, notice: decision.notice };

  const reason = decision.handTo;
  if (live !== undefined) live.offer(url, reason, conversation);
  const guide = browserTexts(deps.ctx.assistant.language).guide(reason, url, live !== undefined);
  return {
    ...base,
    notice: decision.notice,
    handoff: { reason, guide, ...(decision.button !== undefined ? { button: decision.button } : {}) },
    ...(live !== undefined ? { liveView: 'browser-live' as const } : {}),
  };
}

/** What the owner hears when the errand ends: the notice, the guide for a stop, and the app's take-over button. */
export function errandOutcome(output: ErrandOutput): TaskOutcome {
  const link = output.url !== undefined ? { link: output.url } : {};
  // the browser's own words say why (no such page, the agent could not start…)
  if (output.status === 'failed') return { status: 'failed', text: output.text.trim() === '' ? output.notice : `${output.notice}\n(이유: ${output.text.replace(/\s*\n+\s*/g, ' · ').slice(0, 300)})`, ...link };
  if (output.status === 'not_found') return { status: 'done', text: output.notice, ...link };
  // what the browser says it stopped at ("Next action: …"), so a stop is never without a reason
  const why = output.handoff?.reason === 'other' ? /Next action:\s*(.+)/.exec(output.text)?.[1]?.trim().slice(0, 240) : undefined;
  const notice = why !== undefined && why !== '' && why.toLowerCase() !== 'none' ? `${output.notice}\n(멈춘 곳: ${why})` : output.notice;
  const text = output.handoff === undefined ? notice : `${notice}\n\n${output.handoff.guide}`;
  const live =
    output.liveView !== undefined && output.handoff !== undefined
      ? { live: { view: output.liveView, reason: output.handoff.reason, ...(output.url !== undefined ? { url: output.url } : {}) } }
      : {};
  return { status: 'waiting', text, ...link, ...live };
}

export const ERRAND_BACKGROUND_NOTE =
  'Runs in the background: it answers right away with a workId (tell the owner it started and that they will hear ' +
  'back); the result, with what to press, reaches the owner as a notice, and work.status shows it too. ';

/** One short plain reason after the failure text ("(이유: …)"), or nothing when there is none worth showing. */
function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const line = message.split('\n')[0]?.trim().slice(0, 160) ?? '';
  return line === '' ? '' : `\n(이유: ${line})`;
}

/** Starts the errand in the background and answers right away; the result reaches the owner as a notice. */
export function startErrand(deps: ErrandDeps, run: ErrandRun, runCtx: ToolRunContext): Promise<StartedTask> {
  const conversation = runCtx.call.conversation;
  return deps.tasks.start<ErrandOutput>({
    title: run.title,
    ...(conversation !== undefined ? { origin: conversation } : {}),
    timeoutMs: run.timeoutMs,
    run: (signal) => runErrand(deps, run, signal, conversation),
    outcome: errandOutcome,
    failure: (error) => ({ status: 'failed', text: `${deps.texts.failed}${errorReason(error)}` }),
    ...(runCtx.call.afterTurn !== undefined ? { afterTurn: runCtx.call.afterTurn } : {}),
  });
}

const BLOCKED = /access denied|blocking (the |this )?(automated )?(browser|request|access)|bot (detection|protection)|자동.{0,10}(접속|브라우저).{0,10}(막|차단)/i;

/** Login, captcha, consent: always the owner's; the errand continues from `continueUrl` afterwards. */
export function ownerStep(result: BrowserRunResult, texts: ErrandTexts): ErrandDecision | undefined {
  // a site that turns automated browsers away: say so plainly (it is not an option to pick), never work around it
  if (result.status !== 'done' && BLOCKED.test(result.summary)) return { status: 'needs_human', notice: texts.blocked, handTo: 'other' };
  const reason = result.handoff?.reason;
  if (result.status !== 'needs_human' || reason === undefined) return undefined;
  if (reason === 'login' || reason === 'captcha' || reason === 'consent') return { status: 'needs_human', notice: texts.needsHuman, handTo: reason };
  return undefined;
}

export function failedDecision(texts: ErrandTexts): ErrandDecision {
  return { status: 'failed', notice: texts.failed };
}

/** Today's date (YYYY-MM-DD) in the owner's time zone. */
export function todayIn(timeZone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function pastDate(date: string, timeZone: string, now: Date): string | undefined {
  return date < todayIn(timeZone, now) ? `${date} is already past in the owner's time zone.` : undefined;
}
