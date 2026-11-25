/**
 * Configs written before the Claude 5 models still name the old ones (Sonnet 4.5 for everything hard, or the Claude
 * subscription's "sonnet" for the deep tier too). On load they are moved to the current lineup in memory, so an
 * `ax-kit update` alone brings the better models; the file is left as it is.
 */
const RENAMED: Record<string, string> = {
  'claude-sonnet-4-5': 'claude-sonnet-5-5',
  'claude-haiku-4-5': 'claude-haiku-5-5',
};
const DEEP_FOR: Record<string, string> = { 'claude-cli': 'opus', anthropic: 'claude-opus-5-5' };

type Route = Record<string, unknown> & { providerId?: unknown; model?: unknown; tiers?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function upgradeModels(raw: unknown): unknown {
  if (!isRecord(raw) || !isRecord(raw.llm) || !Array.isArray(raw.llm.routes) || !Array.isArray(raw.llm.providers)) return raw;
  const kindOf = new Map<string, string>();
  for (const provider of raw.llm.providers) {
    if (isRecord(provider) && typeof provider.id === 'string' && typeof provider.kind === 'string') kindOf.set(provider.id, provider.kind);
  }
  const routes = raw.llm.routes as Route[];
  const out: Route[] = [];
  for (const route of routes) {
    if (!isRecord(route) || typeof route.model !== 'string' || typeof route.providerId !== 'string' || !Array.isArray(route.tiers)) {
      out.push(route);
      continue;
    }
    const kind = kindOf.get(route.providerId) ?? '';
    const model = RENAMED[route.model] ?? route.model;
    const tiers = route.tiers as unknown[];
    const deepModel = DEEP_FOR[kind];
    // a mid model also serving the deep tier: the deep tier goes to the top model of the same connection
    const midServesDeep = deepModel !== undefined && (model === 'sonnet' || model === 'claude-sonnet-5-5') && tiers.includes('deep') && tiers.length > 1;
    const alreadyDeep = routes.some((other) => isRecord(other) && other.providerId === route.providerId && other.model === deepModel);
    if (midServesDeep && !alreadyDeep) {
      out.push({ ...route, model: deepModel, tiers: ['deep'] });
      out.push({ ...route, model, tiers: tiers.filter((tier) => tier !== 'deep') });
      continue;
    }
    out.push(model === route.model ? route : { ...route, model });
  }
  return { ...raw, llm: { ...raw.llm, routes: out } };
}
