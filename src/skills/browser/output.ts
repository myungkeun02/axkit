import type { BrowserRunResult, HandoffReason } from '../../core/contracts/index.js';
import type { TaskOutcome } from '../work/background.js';
import type { BrowserTexts } from './locale.js';

const MAX_OUTPUT_CHARS = 8000;

export interface BrowserRunOutput {
  status: 'done' | 'needs_human' | 'failed';
  url?: string;
  /** Page-derived text: data the model reads, never instructions. */
  text: string;
  handoff?: { reason: HandoffReason; guide: string; button?: string };
  /**
   * The app view where the owner can take over this page (docs/APP-PROTOCOL.md §22). The assistant loop turns it,
   * with `url` and `handoff.reason`, into the reply's `live` field.
   */
  liveView?: 'browser-live';
}

/** The app's browser screen exists: the adapter can open a live page and the app channel is on. */
export const LIVE_VIEW = 'browser-live';

export function browserRunOutput(
  result: BrowserRunResult,
  texts: BrowserTexts,
  fallbackUrl: string | undefined,
  inApp = false,
): BrowserRunOutput {
  const url = result.url ?? fallbackUrl;
  const text = result.summary.slice(0, MAX_OUTPUT_CHARS);
  if (result.status === 'needs_human') {
    const reason = result.handoff?.reason ?? 'other';
    const handoffUrl = result.handoff?.url ?? url;
    const button = reason === 'other' ? result.handoff?.button : undefined;
    const base = texts.guide(reason, handoffUrl, inApp);
    const guide = button !== undefined ? `${base}\n${texts.buttonGuide(button)}` : base;
    return {
      status: 'needs_human',
      ...(url !== undefined ? { url } : {}),
      text,
      handoff: { reason, guide, ...(button !== undefined ? { button } : {}) },
      ...(inApp ? { liveView: LIVE_VIEW } : {}),
    };
  }
  return { status: result.status, ...(url !== undefined ? { url } : {}), text };
}

/** What the owner hears when a background browser task ends; a stop carries the app's take-over button. */
export function browserOutcome(texts: BrowserTexts, goal: string, output: BrowserRunOutput): TaskOutcome {
  const link = output.url !== undefined ? { link: output.url } : {};
  if (output.status === 'needs_human') {
    const guide = output.handoff?.guide ?? '';
    const live =
      output.liveView !== undefined && output.handoff !== undefined
        ? { live: { view: output.liveView, reason: output.handoff.reason, ...(output.url !== undefined ? { url: output.url } : {}) } }
        : {};
    return { status: 'waiting', text: texts.taskStopped(goal, guide), ...link, ...live };
  }
  if (output.status === 'done') return { status: 'done', text: texts.taskDone(goal, output.text), ...link };
  return { status: 'failed', text: texts.taskFailed(goal, output.text), ...link };
}
