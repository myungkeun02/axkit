import type { SpendEntry } from '../../core/contracts/index.js';
import type { LedgerStore } from './ledger.js';
import type { DetectedSubscription } from './subscriptions.js';
import { detectSubscriptions, LOOKBACK_MS } from './subscriptions.js';

export interface DetectDeps {
  ledger: LedgerStore;
  timeZone: string;
  homeCurrency: string;
}

function chargeOf(entry: SpendEntry, currency: string) {
  return {
    at: new Date(entry.at),
    merchant: entry.merchant,
    merchantKey: entry.merchantKey,
    amount: entry.amount,
    currency,
  };
}

/** Reads the last 400 days of the ledger (excluded entries out) and detects recurring charges. */
export async function loadDetected(deps: DetectDeps, now: Date): Promise<DetectedSubscription[]> {
  const entries = await deps.ledger.list({
    from: new Date(now.getTime() - LOOKBACK_MS),
    to: new Date(now.getTime() + 1),
  });
  const currency = deps.homeCurrency.toUpperCase();
  const charges = entries
    .filter((entry) => entry.excluded !== true)
    .filter((entry) => entry.amount > 0)
    .map((entry) => chargeOf(entry, currency));
  return detectSubscriptions(charges, now, deps.timeZone);
}
