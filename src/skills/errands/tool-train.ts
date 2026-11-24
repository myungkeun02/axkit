import type { Tool } from '../../core/tools/types.js';
import { TRAIN_SITES, trainGoal } from './goals.js';
import { saysNo } from './report.js';
import type { ErrandDecision, ErrandDeps } from './run.js';
import { failedDecision, ownerStep, pastDate, startErrand, ERRAND_BACKGROUND_NOTE } from './run.js';
import type { StartedTask } from '../work/background.js';
import type { TrainInput } from './types.js';
import { trainInput } from './types.js';

/**
 * KTX/SRT: search, compare, pick by the owner's preference, fill passengers and stop before 예매. Only with the
 * owner's yes on a card for that exact button does it hold the seat, and then it stops at the payment screen.
 */
export function trainTool(deps: ErrandDeps): Tool<TrainInput, StartedTask> {
  return {
    name: 'errands.train',
    description:
      ERRAND_BACKGROUND_NOTE +
      'Find a KTX/SRT train and get it ready to book on the owner’s own browser: searches, compares, picks by the ' +
      'owner’s preference and stops right before the 예매 button (logins and payment are the owner’s). Never pays and ' +
      'never polls. When it stops at a login, the owner signs in and you call again with continueUrl. When it reports ' +
      '`handoff.button` and the owner says to press it, call again with approvedButton: it holds the seat and stops ' +
      'at payment. For a seat that may free up later, offer errands.seat_watch instead of repeating this.',
    input: trainInput,
    effects: ['send'],
    describe: (value) => deps.texts.trainCard(value),
    // a card every time, never a standing rule: this can end in a seat held in the owner's name
    uncertainty: () => deps.texts.cardNote,
    reject: (value) => {
      if (value.adults + value.children + value.seniors < 1) return 'At least one passenger is needed.';
      if (value.latest !== undefined && value.latest < value.time) return 'latest must be after time.';
      return pastDate(value.date, deps.ctx.assistant.timezone, deps.ctx.clock.now());
    },
    run: (value, runCtx) =>
      startErrand(
        deps,
        {
          kind: 'train',
          title: `기차표: ${value.from} → ${value.to} ${value.date} ${value.time}`,
          timeoutMs: 20 * 60_000,
          goal: trainGoal(value),
          startUrl: value.continueUrl ?? TRAIN_SITES[value.operator],
          ...(value.approvedButton !== undefined ? { approvedCommit: value.approvedButton } : {}),
          decide: (result, details): ErrandDecision => {
            const owner = ownerStep(result, deps.texts);
            if (owner !== undefined) return owner;
            if (result.status === 'needs_human' && result.handoff?.reason === 'payment') {
              return { status: 'ready', notice: deps.texts.trainHeld(details), handTo: 'payment' };
            }
            if (result.status === 'needs_human') {
              const button = result.handoff?.button;
              // stopped without reaching a booking button: nothing is ready, the owner has to look
              if (button === undefined) return { status: 'needs_human', notice: deps.texts.needsHuman, handTo: 'other' };
              return {
                status: 'ready',
                notice: deps.texts.trainReady(details, button),
                handTo: 'other',
                ...(button !== undefined ? { button } : {}),
              };
            }
            if (result.status === 'done' && saysNo(details['SEATS'])) return { status: 'not_found', notice: deps.texts.trainNone(details) };
            if (result.status === 'done') return { status: 'ready', notice: deps.texts.trainReady(details, undefined), handTo: 'other' };
            return failedDecision(deps.texts);
          },
        },
        runCtx,
      ),
  };
}
