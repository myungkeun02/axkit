import type {
  BudgetConfig,
  LlmGateway,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmRoute,
  LlmRouteFailure,
  LlmRoutingInfo,
  Sensitivity,
  Tier,
  UsageLedger,
} from './types.js';
import { LlmError } from './types.js';
import { ProviderCircuit } from './circuit.js';
import { isContentFault } from './fault.js';
import type { Clock } from '../scheduler/types.js';
import type { Logger } from '../log/types.js';
import { systemClock } from '../scheduler/clock.js';
import { startOfLocalDay, wallClock } from '../scheduler/next-run.js';
import { classifyLlmFailure } from './usage-reader.js';
import type { AttemptResult, RetryPolicy } from './retry.js';
import { DEFAULT_RETRY_POLICY, failureKind, statusOf, withRetries } from './retry.js';

const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 0, masked: 1, sensitive: 2 };
interface GatewayOptions {
  providers: readonly LlmProvider[];
  routes: readonly LlmRoute[];
  budget: BudgetConfig;
  ledger: UsageLedger;
  timeZone: string;
  log: Logger;
  clock?: Clock;
  circuit?: ProviderCircuit;
  /** Same-route retries for transient failures; the defaults allow two, with jittered backoff. */
  retry?: Partial<RetryPolicy>;
}

export class RoutingLlmGateway implements LlmGateway {
  private readonly providers: Map<string, LlmProvider>;
  private readonly clock: Clock;
  private readonly circuit: ProviderCircuit;
  private readonly retry: RetryPolicy;
  private routes: readonly LlmRoute[];
  /** Owner-chosen tier per purpose prefix ("bot.dev", "recordings"); the longest matching prefix wins. */
  private purposeTiers = new Map<string, Tier>();
  /** Tiers whose work is taken in turns by their providers (first model of each), instead of always the first. */
  private spread = new Set<Tier>();
  private turn = 0;

  constructor(private readonly opts: GatewayOptions) {
    this.providers = new Map(opts.providers.map((provider) => [provider.id, provider]));
    this.routes = opts.routes;
    this.clock = opts.clock ?? systemClock;
    this.circuit = opts.circuit ?? new ProviderCircuit({ clock: this.clock, log: opts.log });
    this.retry = { ...DEFAULT_RETRY_POLICY, ...opts.retry };
  }

  /** A key connected in the app takes effect without a restart. */
  setProvider(provider: LlmProvider): void {
    this.providers.set(provider.id, provider);
  }

  removeProvider(id: string): void {
    this.providers.delete(id);
  }

  setRoutes(routes: readonly LlmRoute[]): void {
    this.routes = routes;
  }

  setSpread(tiers: ReadonlySet<Tier>): void {
    this.spread = new Set(tiers);
  }

  /** In a spread tier, the providers' leading models take turns being tried first; the rest keep their order. */
  private rotate(candidates: readonly LlmRoute[], tier: Tier): readonly LlmRoute[] {
    if (!this.spread.has(tier)) return candidates;
    const leaders: LlmRoute[] = [];
    for (const route of candidates) if (!leaders.some((item) => item.providerId === route.providerId)) leaders.push(route);
    if (leaders.length < 2) return candidates;
    const first = leaders[this.turn % leaders.length] as LlmRoute;
    this.turn += 1;
    return [first, ...candidates.filter((route) => route !== first)];
  }

  setPurposeTiers(tiers: ReadonlyMap<string, Tier>): void {
    this.purposeTiers = new Map(tiers);
  }

  private tierFor(request: LlmRequest): Tier {
    let best: { length: number; tier: Tier } | undefined;
    for (const [prefix, tier] of this.purposeTiers) {
      const matches = request.purpose === prefix || request.purpose.startsWith(`${prefix}.`);
      if (matches && (best === undefined || prefix.length > best.length)) best = { length: prefix.length, tier };
    }
    return best?.tier ?? request.tier;
  }

  async complete(original: LlmRequest): Promise<LlmResponse> {
    const tier = this.tierFor(original);
    const request = tier === original.tier ? original : { ...original, tier };
    // C (cheap) runs on B (fast) models until a cheap model is in the lineup
    const routeTier = request.tier === 'cheap' && !this.routes.some((route) => route.tiers.includes('cheap') && this.providers.has(route.providerId)) ? 'fast' : request.tier;
    const matching = this.routes.filter((route) => {
      if (!this.providers.has(route.providerId)) return false;
      if (!route.tiers.includes(routeTier)) return false;
      return SENSITIVITY_RANK[route.maxSensitivity] >= SENSITIVITY_RANK[request.sensitivity];
    });
    const candidates = this.rotate(matching, routeTier);
    if (candidates.length === 0) {
      throw new LlmError(
        'no_route',
        `No route for tier "${request.tier}" at sensitivity "${request.sensitivity}"`,
      );
    }

    await this.checkBudget();

    if (!candidates.some((route) => this.circuit.isAvailable(route.providerId))) {
      throw this.pausedError(candidates);
    }

    const failures: LlmRouteFailure[] = [];
    const messages: string[] = [];
    for (const route of candidates) {
      const provider = this.providers.get(route.providerId);
      if (provider === undefined) continue;
      if (!this.circuit.acquire(route.providerId)) continue;

      let result: AttemptResult<LlmResponse>;
      try {
        result = await withRetries(() => provider.complete(route.model, request), this.retry, request.signal, (error, retry, delayMs) => {
          this.opts.log.info('llm provider retrying', {
            provider: route.providerId,
            model: route.model,
            purpose: request.purpose,
            retry,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      } catch (error) {
        // Only a caller abort escapes withRetries.
        this.circuit.recordAbort(route.providerId);
        throw error;
      }

      if (!result.ok) {
        const { error, attempts } = result;
        // One breaker step per request, however many attempts it took.
        if (isContentFault(error)) this.circuit.recordAbort(route.providerId);
        else this.circuit.recordFailure(route.providerId);
        const code = classifyLlmFailure(error);
        // Bookkeeping must never stop the fallback to the next route.
        await this.opts.ledger
          .recordFailure?.({
            at: this.clock.now(),
            purpose: request.purpose,
            providerId: route.providerId,
            model: route.model,
            code,
            tier: request.tier,
          })
          .catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        const kind = failureKind(error);
        this.opts.log.warn('llm provider failed', {
          provider: route.providerId,
          model: route.model,
          purpose: request.purpose,
          error: message,
          kind,
          attempts,
        });
        const status = statusOf(error);
        failures.push({
          providerId: route.providerId,
          model: route.model,
          kind,
          code,
          attempts,
          ...(status !== undefined ? { status } : {}),
        });
        messages.push(`${route.providerId}: ${message}`);
        continue;
      }

      const response = result.value;
      this.circuit.recordSuccess(route.providerId);
      // Only the answered attempt is charged; failed attempts produced no usage.
      await this.opts.ledger.record({
        at: this.clock.now(),
        purpose: request.purpose,
        providerId: route.providerId,
        model: route.model,
        usage: response.usage,
        tier: request.tier,
      });
      return response;
    }

    if (failures.length === 0) throw this.pausedError(candidates);
    throw new LlmError('provider_failed', `All providers failed: ${messages.join('; ')}`, { failures });
  }

  describe(): LlmRoutingInfo {
    const failed = new Map(this.circuit.snapshot().map((entry) => [entry.providerId, entry]));
    return {
      routes: this.routes,
      activeProviders: [...this.providers.keys()],
      circuits: [...this.providers.keys()].map((providerId) => {
        const entry = failed.get(providerId);
        return {
          providerId,
          state: entry?.state ?? 'closed',
          failures: entry?.failures ?? 0,
          ...(entry?.retryAt !== undefined ? { retryAt: entry.retryAt } : {}),
        };
      }),
    };
  }

  private pausedError(candidates: readonly LlmRoute[]): LlmError {
    const retryAt = this.circuit.retryAfter(candidates.map((route) => route.providerId));
    const at = retryAt ?? this.clock.now();
    return new LlmError(
      'provider_failed',
      `All providers are paused after repeated failures; retrying after ${at.toISOString()}`,
      { retryAt: at, transient: true },
    );
  }

  private async checkBudget(): Promise<void> {
    const now = this.clock.now();
    const today = wallClock(now, this.opts.timeZone);
    const dayStart = startOfLocalDay(today.y, today.m, today.d, this.opts.timeZone);
    const monthStart = startOfLocalDay(today.y, today.m, 1, this.opts.timeZone);

    const daily = await this.opts.ledger.spentUsd(dayStart);
    if (daily >= this.opts.budget.dailyUsd) {
      throw new LlmError(
        'over_budget',
        `Daily budget of $${this.opts.budget.dailyUsd} reached (spent $${daily.toFixed(4)})`,
      );
    }
    const monthly = await this.opts.ledger.spentUsd(monthStart);
    if (monthly >= this.opts.budget.monthlyUsd) {
      throw new LlmError(
        'over_budget',
        `Monthly budget of $${this.opts.budget.monthlyUsd} reached (spent $${monthly.toFixed(4)})`,
      );
    }
  }
}
