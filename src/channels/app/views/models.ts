import { Contracts } from '../../../core/contracts/index.js';
import type { AppView } from '../../../core/contracts/device-api.js';
import type { PurposeModelUsage } from '../../../core/contracts/usage.js';
import type { LlmRoute, LlmRoutingInfo, Sensitivity, Tier } from '../../../core/llm/types.js';
import type { PluginContext } from '../../../core/plugin/types.js';
import { dayRange, ymdOf, ymdPlus } from '../../../core/time/local-day.js';

/** Strongest first, like the S/A/B/C table of the original assistant. */
const TIERS: readonly Tier[] = ['deep', 'standard', 'fast', 'cheap'];
const ACTUAL_DAYS = 7;

const TIER_LABELS: Record<'ko' | 'en', Record<Tier, string>> = {
  ko: { deep: '깊게 생각', standard: '보통', fast: '빠르게', cheap: '가장 싸게' },
  en: { deep: 'Deep', standard: 'Standard', fast: 'Fast', cheap: 'Cheapest' },
};
const SENSITIVITY_NOTES: Record<'ko' | 'en', Record<Sensitivity, string>> = {
  ko: { public: '공개 정보만', masked: '가린 개인정보까지', sensitive: '민감 정보까지' },
  en: { public: 'public data only', masked: 'masked personal data', sensitive: 'sensitive data' },
};

interface Used {
  vendor: string;
  model: string;
  calls: number;
  failures: number;
  costUsd: number;
}

function isTier(value: string | null): value is Tier {
  return value === 'deep' || value === 'standard' || value === 'fast' || value === 'cheap';
}

function routesFor(routes: readonly LlmRoute[], tier: Tier): LlmRoute[] {
  return routes.filter((route) => route.tiers.includes(tier));
}

/**
 * "As configured" for a purpose: a route of its tier or of a stronger tier (a stronger model is not a mismatch). A model
 * id that only adds a suffix (`model-latest`) counts as the same model.
 */
export function acceptedFor(routes: readonly LlmRoute[], tier: Tier, used: { vendor: string; model: string }): boolean {
  const rank = TIERS.indexOf(tier);
  return TIERS.slice(0, rank + 1).some((candidateTier) =>
    routesFor(routes, candidateTier).some(
      (route) =>
        route.providerId === used.vendor && (route.model === used.model || used.model.startsWith(`${route.model}-`)),
    ),
  );
}

function addTo(map: Map<string, Used>, row: PurposeModelUsage): void {
  const key = `${row.providerId}\u0000${row.model}`;
  const existing = map.get(key) ?? { vendor: row.providerId, model: row.model, calls: 0, failures: 0, costUsd: 0 };
  existing.calls += row.calls;
  existing.failures += row.failures;
  existing.costUsd = Math.round((existing.costUsd + row.costUsd) * 10_000) / 10_000;
  map.set(key, existing);
}

function sorted(map: Map<string, Used>): Used[] {
  return [...map.values()].sort(
    (a, b) => b.calls - a.calls || b.failures - a.failures || a.vendor.localeCompare(b.vendor) || a.model.localeCompare(b.model),
  );
}

/** The most frequent requested tier of a purpose; null when every call predates tier recording. */
function tierOf(rows: readonly PurposeModelUsage[]): Tier | null {
  const counts = new Map<Tier, number>();
  for (const row of rows) if (isTier(row.tier)) counts.set(row.tier, (counts.get(row.tier) ?? 0) + row.calls + row.failures);
  let best: Tier | null = null;
  for (const [tier, count] of counts) if (best === null || count > (counts.get(best) ?? 0)) best = tier;
  return best;
}

export function actualOf(routes: readonly LlmRoute[], rows: readonly PurposeModelUsage[]) {
  const byTier = new Map<Tier, Map<string, Used>>();
  const byPurpose = new Map<string, PurposeModelUsage[]>();
  for (const row of rows) {
    if (isTier(row.tier)) {
      const models = byTier.get(row.tier) ?? new Map<string, Used>();
      addTo(models, row);
      byTier.set(row.tier, models);
    }
    byPurpose.set(row.purpose, [...(byPurpose.get(row.purpose) ?? []), row]);
  }
  const purposes = [...byPurpose.entries()].map(([prefix, list]) => {
    const tier = tierOf(list);
    const models = new Map<string, Used>();
    for (const row of list) addTo(models, row);
    const out = sorted(models);
    const top = out[0];
    const mismatch =
      top !== undefined && tier !== null && routesFor(routes, tier).length > 0 && !acceptedFor(routes, tier, top);
    return { prefix, tier: tier ?? '', models: out, mismatch };
  });
  purposes.sort((a, b) => Number(b.mismatch) - Number(a.mismatch) || a.prefix.localeCompare(b.prefix));
  return {
    byTier: TIERS.flatMap((tier) => {
      const models = byTier.get(tier);
      return models === undefined ? [] : [{ tier, models: sorted(models) }];
    }),
    byPurpose: purposes,
  };
}

/** The gateway's tier table next to what really answered in the last 7 days (docs/APP-PROTOCOL.md §7.10). */
export function modelsView(ctx: PluginContext, describe: () => LlmRoutingInfo): AppView {
  return {
    name: 'models',
    version: 1,
    async read() {
      const lang = ctx.assistant.language === 'en' ? 'en' : 'ko';
      const info = describe();
      const active = new Set(info.activeProviders);
      const now = ctx.clock.now();
      const zone = ctx.assistant.timezone;
      const since = dayRange(ymdPlus(ymdOf(now, zone), -(ACTUAL_DAYS - 1)), zone).from;
      const reader = ctx.tryUse(Contracts.usage);
      const rows = reader?.byPurposeModel === undefined ? undefined : await reader.byPurposeModel(since);
      const actual = rows === undefined ? null : { since: since.toISOString(), ...actualOf(info.routes, rows) };
      const tierOfPurpose = new Map(actual?.byPurpose.map((row) => [row.prefix, row.tier]) ?? []);
      return {
        generatedAt: now.toISOString(),
        tiers: TIERS.map((tier) => ({
          id: tier,
          label: TIER_LABELS[lang][tier],
          candidates: routesFor(info.routes, tier).map((route) => ({
            vendor: route.providerId,
            model: route.model,
            note: active.has(route.providerId)
              ? SENSITIVITY_NOTES[lang][route.maxSensitivity]
              : lang === 'en' ? 'provider not enabled' : '공급자 꺼짐',
          })),
        })),
        // ax-kit has no per-purpose table: a purpose asks for a tier on each call, so the list is what was asked lately.
        purposes: [...tierOfPurpose.entries()]
          .filter(([, tier]) => tier !== '')
          .map(([prefix, tier]) => ({ prefix, tier, label: prefix })),
        activeProviders: info.activeProviders,
        circuits: info.circuits.map((circuit) => ({
          vendor: circuit.providerId,
          state: circuit.state === 'half_open' ? 'half-open' : circuit.state,
          ...(circuit.retryAt !== undefined ? { until: circuit.retryAt.toISOString() } : {}),
          ...(circuit.failures > 0
            ? { reason: lang === 'en' ? `${circuit.failures} failures in a row` : `연속 실패 ${circuit.failures}번` }
            : {}),
        })),
        actual,
      };
    },
  };
}
