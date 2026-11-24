import type { Tier } from '../llm/types.js';

/**
 * Capability "core.llm-control" (R7, R12): connect an AI with a key from the app, and choose which models each tier
 * tries first and which tier each purpose uses. Keys go to the Keychain only; nothing here ever returns one.
 */
export interface ProviderEntry {
  id: string;
  label: string;
  kind: 'api_key' | 'subscription' | 'local';
  connected: boolean;
  status?: 'ok' | 'error' | 'off';
  detail?: string;
  /** Last 3 characters of the key, never more. */
  keyHint?: string;
  help?: string;
  models?: string[];
  /** Whether the app may set or remove the key (config-defined CLIs and local servers are explained, not edited). */
  editable: boolean;
}

export type ConnectResult = { ok: true; status: 'ok' | 'error'; detail: string } | { ok: false; reason: string };

export interface TierModel {
  /** "<provider>/<model>". */
  id: string;
  label: string;
  provider: string;
  available: boolean;
  /** The owner ordered this tier; the harness leaves it alone. */
  chosen?: boolean;
  note?: string;
}

export interface PurposeEntry {
  id: string;
  label: string;
  tier: Tier;
  /** True when the owner chose it; otherwise it is what callers ask for. */
  chosen: boolean;
  calls7d?: number;
}

export interface LlmControl {
  providers(): Promise<ProviderEntry[]>;
  connect(id: string, apiKey: string): Promise<ConnectResult>;
  disconnect(id: string): Promise<boolean>;
  tiers(): Promise<{ tier: Tier; models: TierModel[] }[]>;
  /** Same set of model ids in a new order; anything else is refused. */
  rank(tier: Tier, order: readonly string[]): Promise<boolean>;
  /** A purpose prefix ("bot.dev", "recordings") and its tier; null puts it back to what callers ask for. */
  setPurpose(id: string, tier: Tier | null): Promise<void>;
  purposeTiers(): Promise<ReadonlyMap<string, Tier>>;
  /** Spend is running ahead of the budget (last 7 days against the monthly pace, or today near the daily limit). */
  overBudget(): Promise<boolean>;
  /** What the tier harness decided: purpose tiers it set, and its last changes in plain words (newest first). */
  harnessState(): Promise<{ autoPurposes: Readonly<Record<string, Tier>>; changes: readonly { at: string; text: string }[] }>;
}
