import type { Tool } from '../../core/tools/types.js';
import { shopGoal } from './goals.js';
import { saysNo } from './report.js';
import type { ErrandDecision, ErrandDeps } from './run.js';
import { failedDecision, ownerStep, startErrand, ERRAND_BACKGROUND_NOTE } from './run.js';
import type { StartedTask } from '../work/background.js';
import type { ShopInput } from './types.js';
import { shopInput } from './types.js';

function startOf(value: ShopInput): string {
  if (value.continueUrl !== undefined) return value.continueUrl;
  if (value.url !== undefined) return value.url;
  return `https://${value.site ?? ''}/`;
}

/** Shopping: the cart is the last step. Ordering and paying are handed to the owner on the cart page. */
export function shopTool(deps: ErrandDeps): Tool<ShopInput, StartedTask> {
  return {
    name: 'errands.shop',
    description:
      ERRAND_BACKGROUND_NOTE +
      'Put a product in the cart on the owner’s own browser and hand ordering and payment to the owner: opens the ' +
      'product page (url, e.g. a watch alert link) or searches the store site, sets quantity and options, adds it to ' +
      'the cart and reports item, options, price and delivery. Never orders or pays. If an option is unclear it stops ' +
      'and asks. After a login stop, call again with continueUrl.',
    input: shopInput,
    effects: ['send'],
    describe: (value) => deps.texts.shopCard(value),
    uncertainty: () => deps.texts.cardNote,
    run: (value, runCtx) =>
      startErrand(
        deps,
        {
          kind: 'shop',
          title: `장바구니: ${value.product}`,
          timeoutMs: 15 * 60_000,
          goal: shopGoal(value),
          startUrl: startOf(value),
          decide: (result, details): ErrandDecision => {
            const owner = ownerStep(result, deps.texts);
            if (owner !== undefined) return owner;
            // the harness stopped at an order or payment button: the cart is ready and the rest is the owner's
            if (result.status === 'needs_human' && result.handoff?.reason === 'payment') {
              return { status: 'ready', notice: deps.texts.shopReady(details), handTo: 'payment' };
            }
            if (result.status === 'needs_human') return { status: 'ask', notice: deps.texts.shopChoice, handTo: 'other' };
            if (result.status === 'done' && saysNo(details['ADDED'])) return { status: 'not_found', notice: deps.texts.shopNotAdded(details) };
            if (result.status === 'done') return { status: 'ready', notice: deps.texts.shopReady(details), handTo: 'payment' };
            return failedDecision(deps.texts);
          },
        },
        runCtx,
      ),
  };
}
