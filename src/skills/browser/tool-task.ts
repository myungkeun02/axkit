import { z } from 'zod';
import type { BrowserAuthHelper } from '../../core/contracts/index.js';
import type { Tool } from '../../core/tools/types.js';
import type { StartedTask } from '../work/background.js';
import { authHelperFor } from './auto-auth.js';
import type { BrowserSkillDeps } from './deps.js';
import { liveInApp } from './deps.js';
import type { BrowserRunOutput } from './output.js';
import { browserOutcome, browserRunOutput } from './output.js';
import { httpUrl } from './schema.js';

/** A multi-step errand may take a while on slow sites; past this it is stopped and reported as failed. */
export const BROWSER_TASK_TIMEOUT_MS = 30 * 60_000;
const MAX_TITLE_CHARS = 80;

const input = z.object({
  goal: z.string().min(1).max(500).describe("What to do, in the owner's words."),
  startUrl: httpUrl.optional().describe('Where to start, http or https only. To continue after a handoff: the url it stopped at.'),
  approvedButton: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .optional()
    .describe(
      'Only when continuing after a handoff that reported `button` and the owner said in chat to press it: that exact button name. ' +
        'The owner sees it on the card again. Payment buttons are never pressed.',
    ),
});

export type BrowserTaskInput = z.infer<typeof input>;

function titleOf(goal: string): string {
  const line = goal.trim().split('\n')[0]?.trim() ?? '';
  return line.length <= MAX_TITLE_CHARS ? line : `${line.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

export function browserTaskTool(deps: BrowserSkillDeps): Tool<BrowserTaskInput, StartedTask> {
  return {
    name: 'browser.task',
    description:
      'Give a multi-step errand to the browser on this Mac. It runs in the background: it answers right away with a ' +
      'workId (tell the owner it started and that they will hear back), and the result reaches the owner as a notice; ' +
      'work.status shows progress and the outcome, including the url a stop left. It stops at login, payment, consent ' +
      'and captcha screens and hands them to the owner. It never types passwords, card numbers or one-time codes, ' +
      'never accepts terms, and never pays, orders or books. Always asks the owner first. Once the owner says they ' +
      'finished a handoff (e.g. "계속"), call it again with the same goal and startUrl = the url it stopped at — the ' +
      'login stays in the browser profile. A stop before a final button names that button; only if the owner then ' +
      'says to press it, pass it as approvedButton.',
    input,
    effects: ['send'],
    describe(value) {
      const base = deps.texts.taskDescription(value.goal, value.startUrl);
      const lines = [base];
      if (value.approvedButton !== undefined) lines.push(deps.texts.pressButton(value.approvedButton));
      if (helperFor(deps, value) !== undefined) lines.push(deps.texts.autoAuthOn);
      return lines.join('\n');
    },
    // pressing a final button is always the owner's own yes on this card, never a standing "just do it" rule
    uncertainty(value) {
      return value.approvedButton === undefined ? undefined : deps.texts.pressButtonNote;
    },
    async run(value, runCtx) {
      const conversation = runCtx.call.conversation;
      return deps.tasks.start<BrowserRunOutput>({
        title: titleOf(value.goal),
        ...(conversation !== undefined ? { origin: conversation } : {}),
        ...(runCtx.call.afterTurn !== undefined ? { afterTurn: runCtx.call.afterTurn } : {}),
        timeoutMs: BROWSER_TASK_TIMEOUT_MS,
        run: async (signal) => {
          // only this owner-approved run gets a code helper, and only for a start site on the allowed list
          const auth = helperFor(deps, value);
          const inApp = liveInApp(deps);
          const result = await deps.agent.run(
            {
              goal: value.goal,
              ...(value.startUrl !== undefined ? { startUrl: value.startUrl } : {}),
              ...(auth !== undefined ? { auth } : {}),
              ...(value.approvedButton !== undefined ? { approvedCommit: value.approvedButton } : {}),
              // the app can take over this exact page (half-filled forms included) instead of reloading it
              ...(inApp ? { keepPage: true } : {}),
            },
            signal,
          );
          const handoffUrl = result.handoff?.url ?? result.url ?? value.startUrl;
          if (result.status === 'needs_human' && inApp && handoffUrl !== undefined) {
            // the owner takes the page over from the app; "done" continues in the conversation the errand came from
            deps.live?.offer(handoffUrl, result.handoff?.reason ?? 'other', conversation);
          }
          return browserRunOutput(result, deps.texts, value.startUrl, inApp);
        },
        outcome: (output) => browserOutcome(deps.texts, value.goal, output),
        failure: (error) => ({
          status: 'failed',
          text: deps.texts.taskFailed(value.goal, error instanceof Error ? error.message : String(error)),
        }),
      });
    },
  };
}

function helperFor(deps: BrowserSkillDeps, value: BrowserTaskInput): BrowserAuthHelper | undefined {
  if (deps.autoAuth === undefined) return undefined;
  return authHelperFor(deps.ctx, deps.autoAuth, deps.texts, value.goal, value.startUrl);
}
