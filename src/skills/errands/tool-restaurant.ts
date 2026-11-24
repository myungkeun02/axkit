import type { Tool } from '../../core/tools/types.js';
import { RESTAURANT_SITES, restaurantGoal } from './goals.js';
import { cancellationUnclear, hasDeposit, saysNo } from './report.js';
import type { ErrandDecision, ErrandDeps } from './run.js';
import { failedDecision, ownerStep, pastDate, startErrand, ERRAND_BACKGROUND_NOTE } from './run.js';
import type { StartedTask } from '../work/background.js';
import type { RestaurantInput } from './types.js';
import { restaurantInput } from './types.js';

/**
 * A table: date, time and party filled, stopped before [예약하기]. A deposit or prepayment, or a cancellation rule
 * the browser could not read plainly, always turns into a question for the owner instead of a ready page.
 */
export function restaurantTool(deps: ErrandDeps): Tool<RestaurantInput, StartedTask> {
  return {
    name: 'errands.restaurant',
    description:
      ERRAND_BACKGROUND_NOTE +
      'Get a restaurant reservation ready on the owner’s own browser (네이버 예약 or 캐치테이블, or the given booking ' +
      'page): fills date, time and party size and stops before the final 예약하기 button; the owner presses it. A ' +
      'deposit/prepayment or an unclear cancellation rule comes back as status "ask": tell the owner and let them ' +
      'decide; never pay a deposit and never press its button for the owner (browser.task approvedButton) while it ' +
      'is "ask". After a login stop, call again with continueUrl.',
    input: restaurantInput,
    effects: ['send'],
    describe: (value) => deps.texts.restaurantCard(value),
    uncertainty: () => deps.texts.cardNote,
    reject: (value) => pastDate(value.date, deps.ctx.assistant.timezone, deps.ctx.clock.now()),
    run: (value, runCtx) =>
      startErrand(
        deps,
        {
          kind: 'restaurant',
          title: `식당 예약: ${value.place} ${value.date} ${value.time}`,
          timeoutMs: 15 * 60_000,
          goal: restaurantGoal(value),
          startUrl: value.continueUrl ?? value.url ?? RESTAURANT_SITES[value.site],
          decide: (result, details): ErrandDecision => {
            const owner = ownerStep(result, deps.texts);
            if (owner !== undefined) return owner;
            // a payment screen on the way to a table is a deposit, whatever the report says
            if (result.status === 'needs_human' && result.handoff?.reason === 'payment') {
              return { status: 'ask', notice: deps.texts.restaurantDeposit(details), handTo: 'payment' };
            }
            if (result.status === 'done' && saysNo(details['AVAILABLE'])) {
              return { status: 'not_found', notice: deps.texts.restaurantNone(details) };
            }
            if (result.status === 'failed') return failedDecision(deps.texts);
            const button = result.handoff?.button;
            const at = button !== undefined ? { button } : {};
            // a question carries no button: the owner reads the terms and presses it themselves
            if (hasDeposit(details, result.summary)) return { status: 'ask', notice: deps.texts.restaurantDeposit(details), handTo: 'other' };
            if (cancellationUnclear(details)) return { status: 'ask', notice: deps.texts.restaurantCancelUnclear(details), handTo: 'other' };
            return { status: 'ready', notice: deps.texts.restaurantReady(details, button), handTo: 'other', ...at };
          },
        },
        runCtx,
      ),
  };
}
