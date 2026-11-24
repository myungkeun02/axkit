/**
 * Data sensitivity of a request. A provider only receives requests at or below what the owner allowed for it.
 * - public:    web results, general questions
 * - masked:    personal data with emails/phones/numbers masked by code
 * - sensitive: raw personal data (mail bodies, chats, files, location, spending)
 */
export type Sensitivity = 'public' | 'masked' | 'sensitive';

/** fast = classify/summarize, standard = assistant turns, deep = planning and hard reasoning. */
/** Strongest first: deep (S), standard (A), fast (B), cheap (C: small or local models). */
export type Tier = 'fast' | 'standard' | 'deep' | 'cheap';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  /** Which feature asked, for the usage ledger ("assistant.turn", "briefing.morning"). */
  purpose: string;
  tier: Tier;
  sensitivity: Sensitivity;
  messages: readonly ChatMessage[];
  /** JSON Schema for structured output; providers without native support get it in the prompt. */
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LlmResponse {
  text: string;
  providerId: string;
  model: string;
  usage: LlmUsage;
}

/** One vendor (Anthropic, OpenAI, DeepSeek, a local Ollama...). Knows nothing about routing or budgets. */
export interface LlmProvider {
  id: string;
  complete(model: string, request: LlmRequest): Promise<LlmResponse>;
}

/** A configured choice: which provider/model serves which tier, and the highest sensitivity it may see. */
export interface LlmRoute {
  providerId: string;
  model: string;
  tiers: readonly Tier[];
  maxSensitivity: Sensitivity;
}

export interface BudgetConfig {
  dailyUsd: number;
  monthlyUsd: number;
}

export interface UsageLedger {
  /** `tier` is what the request asked for, so the app can compare it with the model that answered. */
  record(entry: { at: Date; purpose: string; providerId: string; model: string; usage: LlmUsage; tier?: Tier }): Promise<void>;
  spentUsd(since: Date): Promise<number>;
  /** A failed provider call, classified for the usage reader. Never carries message text. */
  recordFailure?(entry: {
    at: Date;
    purpose: string;
    providerId: string;
    model: string;
    code: string;
    tier?: Tier;
  }): Promise<void>;
}

export type LlmErrorCode = 'no_route' | 'over_budget' | 'provider_failed';

/**
 * Why one route failed:
 * - transient: overloaded, throttled, 5xx, timeout or network; trying again later may work
 * - auth:      key or CLI login rejected; the owner has to fix it
 * - request:   this request or its answer was the problem (4xx, malformed or empty answer); retrying will not help
 * - unknown:   anything else
 */
export type LlmFailureKind = 'transient' | 'auth' | 'request' | 'unknown';

export interface LlmRouteFailure {
  providerId: string;
  model: string;
  kind: LlmFailureKind;
  /** Short class from the usage ledger ("timeout", "rate_limited"); never message text. */
  code: string;
  /** Calls made on this route, retries included. */
  attempts: number;
  /** HTTP status, when the provider answered with one. */
  status?: number;
}

export interface LlmErrorDetails {
  failures?: readonly LlmRouteFailure[];
  /** Set for paused providers: the earliest time one accepts requests again. */
  retryAt?: Date;
  /** Overrides the value derived from `failures`. */
  transient?: boolean;
}

export class LlmError extends Error {
  /** One entry per route tried, in order. Empty for no_route, over_budget and paused providers. */
  readonly failures: readonly LlmRouteFailure[];
  readonly retryAt: Date | undefined;
  /**
   * True when the providers are down or busy (every route failed transiently, or all are paused), so the same
   * request may work later. False for a bad request, a login problem, no route or the budget.
   */
  readonly transient: boolean;

  constructor(
    readonly code: LlmErrorCode,
    message: string,
    details: LlmErrorDetails = {},
  ) {
    super(message);
    this.name = 'LlmError';
    this.failures = details.failures ?? [];
    this.retryAt = details.retryAt;
    this.transient =
      details.transient ?? (this.failures.length > 0 && this.failures.every((failure) => failure.kind === 'transient'));
  }
}

export interface CircuitSnapshot {
  providerId: string;
  state: 'closed' | 'open' | 'half_open';
  /** When an open circuit lets a trial through. */
  retryAt?: Date;
  /** Consecutive failures counted while still closed. */
  failures: number;
}

/** The routing table as configured, for the app's models screen. Never carries keys. */
export interface LlmRoutingInfo {
  routes: readonly LlmRoute[];
  /** Providers that were created (key found, CLI present). */
  activeProviders: readonly string[];
  circuits: readonly CircuitSnapshot[];
}

/** What features use. Picks a route by tier and sensitivity, enforces the budget, falls back on failure. */
export interface LlmGateway {
  complete(request: LlmRequest): Promise<LlmResponse>;
  /** Read-only view of routes and breaker state. */
  describe?(): LlmRoutingInfo;
}
