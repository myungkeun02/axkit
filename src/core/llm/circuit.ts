import type { Clock } from '../scheduler/types.js';
import type { Logger } from '../log/types.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitOptions {
  clock: Clock;
  log?: Logger;
  /** Consecutive failures that open the circuit. */
  threshold?: number;
  cooldownMs?: number;
  maxCooldownMs?: number;
}

interface CircuitEntry {
  state: CircuitState;
  failures: number;
  openedAt: number;
  cooldownMs: number;
  trial: boolean;
}

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_MAX_COOLDOWN_MS = 30 * 60_000;

/**
 * Per-provider breaker: repeated failures pause a provider, one trial is let through after the cooldown,
 * and a failed trial re-opens it with a doubled (capped) cooldown.
 */
export class ProviderCircuit {
  private readonly entries = new Map<string, CircuitEntry>();
  private readonly clock: Clock;
  private readonly log: Logger | undefined;
  private readonly threshold: number;
  private readonly baseCooldownMs: number;
  private readonly maxCooldownMs: number;

  constructor(opts: CircuitOptions) {
    this.clock = opts.clock;
    this.log = opts.log;
    this.threshold = Math.max(1, opts.threshold ?? DEFAULT_THRESHOLD);
    this.baseCooldownMs = Math.max(1, opts.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.maxCooldownMs = Math.max(this.baseCooldownMs, opts.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS);
  }

  stateOf(providerId: string): CircuitState {
    return this.entries.get(providerId)?.state ?? 'closed';
  }

  /** Whether a request could be tried now; does not consume a half-open trial. */
  isAvailable(providerId: string): boolean {
    const entry = this.entries.get(providerId);
    if (entry === undefined || entry.state === 'closed') return true;
    if (entry.state === 'half_open') return !entry.trial;
    return this.cooledDown(entry);
  }

  /** Reserves the single half-open trial; returns false when the provider must be skipped. */
  acquire(providerId: string): boolean {
    const entry = this.entries.get(providerId);
    if (entry === undefined || entry.state === 'closed') return true;
    if (entry.state === 'half_open') {
      if (entry.trial) return false;
      entry.trial = true;
      return true;
    }
    if (!this.cooledDown(entry)) return false;
    entry.state = 'half_open';
    entry.trial = true;
    return true;
  }

  recordSuccess(providerId: string): void {
    const entry = this.entries.get(providerId);
    if (entry === undefined) return;
    const wasPaused = entry.state !== 'closed';
    this.entries.delete(providerId);
    if (wasPaused) this.log?.info('llm provider circuit closed', { provider: providerId });
  }

  recordFailure(providerId: string): void {
    const entry = this.entryFor(providerId);
    if (entry.state === 'open') return;
    if (entry.state === 'half_open') {
      entry.trial = false;
      this.open(providerId, entry, Math.min(entry.cooldownMs * 2, this.maxCooldownMs));
      return;
    }
    entry.failures += 1;
    if (entry.failures >= this.threshold) this.open(providerId, entry, this.baseCooldownMs);
  }

  /** A caller abort says nothing about the provider; release the trial without re-opening. */
  recordAbort(providerId: string): void {
    const entry = this.entries.get(providerId);
    if (entry?.state !== 'half_open') return;
    entry.state = 'open';
    entry.trial = false;
  }

  retryAt(providerId: string): Date | undefined {
    const entry = this.entries.get(providerId);
    if (entry === undefined || entry.state !== 'open') return undefined;
    return new Date(entry.openedAt + entry.cooldownMs);
  }

  /** Breaker state of every provider that failed since the last success. */
  snapshot(): { providerId: string; state: CircuitState; retryAt?: Date; failures: number }[] {
    return [...this.entries.entries()].map(([providerId, entry]) => {
      const retryAt = entry.state === 'open' ? new Date(entry.openedAt + entry.cooldownMs) : undefined;
      return { providerId, state: entry.state, failures: entry.failures, ...(retryAt !== undefined ? { retryAt } : {}) };
    });
  }

  /** Earliest time any of the providers accepts requests again. */
  retryAfter(providerIds: readonly string[]): Date | undefined {
    let earliest: Date | undefined;
    for (const providerId of providerIds) {
      const at = this.retryAt(providerId);
      if (at === undefined) continue;
      if (earliest === undefined || at.getTime() < earliest.getTime()) earliest = at;
    }
    return earliest;
  }

  private entryFor(providerId: string): CircuitEntry {
    let entry = this.entries.get(providerId);
    if (entry === undefined) {
      entry = { state: 'closed', failures: 0, openedAt: 0, cooldownMs: this.baseCooldownMs, trial: false };
      this.entries.set(providerId, entry);
    }
    return entry;
  }

  private cooledDown(entry: CircuitEntry): boolean {
    return this.clock.now().getTime() - entry.openedAt >= entry.cooldownMs;
  }

  private open(providerId: string, entry: CircuitEntry, cooldownMs: number): void {
    entry.state = 'open';
    entry.trial = false;
    entry.openedAt = this.clock.now().getTime();
    entry.cooldownMs = cooldownMs;
    this.log?.warn('llm provider circuit opened', { provider: providerId, cooldownMs });
  }
}
