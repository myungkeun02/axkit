import type { Config } from '../core/config/schema.js';
import type { ConnectResult, LlmControl, ProviderEntry, TierModel } from '../core/contracts/llm-control.js';
import type { RoutingLlmGateway } from '../core/llm/gateway.js';
import type { LlmRoute, Tier, UsageLedger } from '../core/llm/types.js';
import type { AuditLog } from '../core/log/types.js';
import type { SecretStore } from '../core/secrets/types.js';
import type { KeyValueStore } from '../core/store/types.js';
import { CATALOG, catalogProvider, catalogRoutes, checkKey } from './llm-catalog.js';
import type { ProviderConfig } from './llm-catalog.js';
import { makeProvider } from './llm-providers.js';

const TIERS: readonly Tier[] = ['deep', 'standard', 'fast', 'cheap'];
const KEY = 'settings';

/** A model the tier harness found in a provider's own list (pending = a new S model waiting for the owner's yes). */
export interface LineupModel {
  model: string;
  tiers: Tier[];
  note: string;
  at: string;
  pending?: boolean;
  /** Test-set result (passed of total, average seconds), when it ran. */
  score?: { passed: number; total: number; ms: number };
  /** The owner said no to it; it stays out of the lineup. */
  declined?: boolean;
}

export interface LlmSettings {
  /** The owner's order per tier; a tier with one is never reordered by the harness. */
  order?: Partial<Record<Tier, string[]>>;
  /** The owner's tier per purpose; always wins over `autoPurposes`. */
  purposes?: Record<string, Tier>;
  /** Per provider: last 3 key characters and how the last check went. */
  keys?: Record<string, { hint: string; status: 'ok' | 'error' }>;
  lineup?: Record<string, LineupModel[]>;
  autoOrder?: Partial<Record<Tier, string[]>>;
  autoPurposes?: Record<string, Tier>;
  changes?: { at: string; text: string }[];
  reviewedAt?: string;
  /** Tiers the harness spreads across providers; a tier the owner ordered is never spread. */
  spread?: Partial<Record<Tier, boolean>>;
}
type Saved = LlmSettings;

export interface LlmControlOptions {
  config: Config;
  secrets: SecretStore;
  gateway: RoutingLlmGateway;
  kv: KeyValueStore;
  audit: AuditLog;
  now: () => Date;
  ledger?: Pick<UsageLedger, 'spentUsd'>;
  /** The tier harness's discovery, run right after a key is connected. */
  onConnected?: (id: string, key: string) => Promise<unknown>;
  fetch?: typeof fetch;
}

function routeId(route: LlmRoute): string {
  return `${route.providerId}/${route.model}`;
}

/**
 * The app's AI settings (R7, R12) as an overlay on config.json: catalog AIs connected with a key, the order of models
 * inside each tier, and a tier per purpose. Saved in the local store and applied to the running gateway at once.
 */
export class AppLlmControl implements LlmControl {
  private readonly korean: boolean;

  constructor(private readonly opts: LlmControlOptions) {
    this.korean = opts.config.assistant.language !== 'en';
  }

  /** At start: catalog AIs whose key is in the Keychain join the gateway, then routes and purpose tiers apply. */
  async apply(): Promise<void> {
    for (const entry of CATALOG) {
      if (this.configured(entry.id) !== undefined) continue;
      const key = await this.opts.secrets.get(entry.secret).catch(() => undefined);
      if (key !== undefined && key !== '') this.opts.gateway.setProvider(makeProvider(catalogProvider(entry), key));
    }
    await this.refresh();
  }

  async providers(): Promise<ProviderEntry[]> {
    const saved = await this.saved();
    const active = new Set(this.opts.gateway.describe().activeProviders);
    const lang = this.korean ? 'ko' : 'en';
    const out: ProviderEntry[] = [];
    for (const provider of this.all()) {
      const entry = CATALOG.find((item) => item.id === provider.id);
      const kind = provider.kind === 'claude-cli' || provider.kind === 'codex-cli' ? 'subscription' : provider.apiKeySecret === undefined ? 'local' : 'api_key';
      const connected = active.has(provider.id);
      const key = saved.keys?.[provider.id];
      const status = !connected ? 'off' : key?.status ?? 'ok';
      out.push({
        id: provider.id,
        label: entry?.label ?? provider.id,
        kind,
        connected,
        status,
        detail: this.statusText(status, kind),
        ...(connected && key !== undefined ? { keyHint: `…${key.hint}` } : {}),
        ...(entry !== undefined ? { help: entry.help[lang] } : kind === 'subscription' ? { help: this.text('맥에서 로그인한 구독을 써요. 앱에서는 바꿀 수 없어요.', 'Uses the subscription signed in on the Mac.') } : {}),
        models: this.baseRoutes(active, saved).filter((route) => route.providerId === provider.id).map((route) => route.model),
        editable: kind === 'api_key',
      });
    }
    return out;
  }

  async connect(id: string, apiKey: string): Promise<ConnectResult> {
    const provider = this.all().find((item) => item.id === id);
    if (provider?.apiKeySecret === undefined) return { ok: false, reason: this.text('여기서 키로 연결하는 AI가 아니에요.', 'This AI is not connected with a key.') };
    const key = apiKey.trim();
    if (!/^\S{10,300}$/.test(key)) return { ok: false, reason: this.text('키 모양이 아니에요. 복사한 키를 그대로 붙여 넣어 주세요.', 'That does not look like a key.') };
    const check = await checkKey(provider, key, this.opts.fetch);
    if (check === 'rejected') return { ok: false, reason: this.text('이 키는 거절됐어요. 키를 다시 확인해 주세요.', 'The key was rejected.') };
    await this.opts.secrets.set(provider.apiKeySecret, key);
    this.opts.gateway.setProvider(makeProvider(provider, key));
    const status = check === 'ok' ? 'ok' : 'error';
    const saved = await this.saved();
    await this.save({ ...saved, keys: { ...saved.keys, [id]: { hint: key.slice(-3), status } } });
    await this.refresh();
    await this.opts.audit.append({ at: this.opts.now(), kind: 'llm.connect', subject: id, detail: { status } }).catch(() => undefined);
    // the owner just connected it: every usable model joins the lineup now, placed by the tier harness
    if (status === 'ok') await this.opts.onConnected?.(id, key).catch(() => undefined);
    return {
      ok: true,
      status,
      detail: status === 'ok' ? this.text('연결했어요. 잘 되고 있어요.', 'Connected.') : this.text('저장했지만 지금은 확인하지 못했어요. 인터넷이 되면 다시 확인해요.', 'Saved, but could not check it now.'),
    };
  }

  async disconnect(id: string): Promise<boolean> {
    const provider = this.all().find((item) => item.id === id);
    if (provider?.apiKeySecret === undefined) return false;
    await this.opts.secrets.delete(provider.apiKeySecret);
    this.opts.gateway.removeProvider(id);
    const saved = await this.saved();
    const keys = Object.fromEntries(Object.entries(saved.keys ?? {}).filter(([name]) => name !== id));
    await this.save({ ...saved, keys });
    await this.refresh();
    await this.opts.audit.append({ at: this.opts.now(), kind: 'llm.disconnect', subject: id, detail: {} }).catch(() => undefined);
    return true;
  }

  async tiers(): Promise<{ tier: Tier; models: TierModel[] }[]> {
    const active = new Set(this.opts.gateway.describe().activeProviders);
    const saved = await this.saved();
    const routes = this.ordered(this.baseRoutes(active, saved), saved);
    const noteOf = (route: LlmRoute): string | undefined => {
      const found = saved.lineup?.[route.providerId]?.find((item) => item.model === route.model)?.note;
      const sensitive = route.maxSensitivity !== 'sensitive' ? this.text('민감한 내용은 맡기지 않아요', 'Not for sensitive data') : undefined;
      return [found, sensitive].filter((part) => part !== undefined).join(' · ') || undefined;
    };
    return TIERS.map((tier) => ({
      tier,
      models: routes
        .filter((route) => route.tiers.includes(tier))
        .map((route) => ({
          id: routeId(route),
          label: route.model,
          provider: CATALOG.find((entry) => entry.id === route.providerId)?.label ?? route.providerId,
          available: active.has(route.providerId),
          chosen: saved.order?.[tier] !== undefined,
          ...((note) => (note !== undefined ? { note } : {}))(noteOf(route)),
        })),
    }));
  }

  async rank(tier: Tier, order: readonly string[]): Promise<boolean> {
    const current = (await this.tiers()).find((row) => row.tier === tier)?.models.map((model) => model.id) ?? [];
    if (order.length !== current.length || new Set(order).size !== order.length || !order.every((id) => current.includes(id))) return false;
    const saved = await this.saved();
    await this.save({ ...saved, order: { ...saved.order, [tier]: [...order] } });
    await this.refresh();
    return true;
  }

  async setPurpose(id: string, tier: Tier | null): Promise<void> {
    const saved = await this.saved();
    const purposes = Object.fromEntries(Object.entries(saved.purposes ?? {}).filter(([name]) => name !== id));
    if (tier !== null) purposes[id] = tier;
    await this.save({ ...saved, purposes });
    await this.refresh();
  }

  async overBudget(): Promise<boolean> {
    const ledger = this.opts.ledger;
    if (ledger === undefined) return false;
    const now = this.opts.now().getTime();
    const { dailyUsd, monthlyUsd } = this.opts.config.llm.budget;
    const week = await ledger.spentUsd(new Date(now - 7 * 86_400_000)).catch(() => 0);
    const day = await ledger.spentUsd(new Date(now - 86_400_000)).catch(() => 0);
    return week > (monthlyUsd * 7) / 30 || day > dailyUsd * 0.8;
  }

  async purposeTiers(): Promise<ReadonlyMap<string, Tier>> {
    return new Map(Object.entries((await this.saved()).purposes ?? {}));
  }

  async harnessState(): Promise<{ autoPurposes: Readonly<Record<string, Tier>>; changes: readonly { at: string; text: string }[] }> {
    const saved = await this.saved();
    return { autoPurposes: saved.autoPurposes ?? {}, changes: saved.changes ?? [] };
  }

  /** For the tier harness: the whole overlay. */
  async settings(): Promise<LlmSettings> {
    return await this.saved();
  }

  /** For the tier harness: change its own fields, log what changed in plain words, apply at once. */
  async harnessWrite(update: (current: LlmSettings) => LlmSettings, changes: readonly string[]): Promise<void> {
    const next = update(await this.saved());
    const at = this.opts.now().toISOString();
    const log = [...changes.map((text) => ({ at, text })), ...(next.changes ?? [])].slice(0, 20);
    await this.save({ ...next, changes: log });
    await this.refresh();
  }

  /** Configured providers and catalog ones, for discovery. */
  providerConfig(id: string): ProviderConfig | undefined {
    return this.all().find((item) => item.id === id);
  }

  private configured(id: string): ProviderConfig | undefined {
    return this.opts.config.llm.providers.find((provider) => provider.id === id);
  }

  private all(): ProviderConfig[] {
    return [...this.opts.config.llm.providers, ...CATALOG.filter((entry) => this.configured(entry.id) === undefined).map(catalogProvider)];
  }

  /** Config routes, then connected catalog AIs: the models the harness found, or the built-in list until then. */
  private baseRoutes(active: ReadonlySet<string>, saved: Saved): LlmRoute[] {
    const extra = CATALOG.filter((entry) => this.configured(entry.id) === undefined && active.has(entry.id)).flatMap((entry) => {
      const found = saved.lineup?.[entry.id]?.filter((item) => item.pending !== true && item.declined !== true);
      return found === undefined || found.length === 0
        ? catalogRoutes(entry)
        : found.map((item) => ({ providerId: entry.id, model: item.model, tiers: item.tiers, maxSensitivity: entry.maxSensitivity }));
    });
    return [...this.opts.config.llm.routes, ...extra];
  }

  /** One route per tier, in the owner's order where given (models not in the saved order keep their place after it). */
  private ordered(routes: readonly LlmRoute[], saved: Saved): LlmRoute[] {
    return TIERS.flatMap((tier) => {
      const inTier = routes.filter((route) => route.tiers.includes(tier));
      const seen = new Set<string>();
      const unique = inTier.filter((route) => !seen.has(routeId(route)) && seen.add(routeId(route)) !== undefined);
      const order = saved.order?.[tier] ?? saved.autoOrder?.[tier] ?? [];
      const rank = (route: LlmRoute): number => {
        const index = order.indexOf(routeId(route));
        return index < 0 ? order.length + unique.indexOf(route) : index;
      };
      return [...unique].sort((a, b) => rank(a) - rank(b)).map((route) => ({ ...route, tiers: [tier] }));
    });
  }

  private async refresh(): Promise<void> {
    const saved = await this.saved();
    const active = new Set(this.opts.gateway.describe().activeProviders);
    this.opts.gateway.setRoutes(this.ordered(this.baseRoutes(active, saved), saved));
    this.opts.gateway.setPurposeTiers(new Map(Object.entries({ ...saved.autoPurposes, ...saved.purposes })));
    this.opts.gateway.setSpread(new Set(TIERS.filter((tier) => saved.spread?.[tier] === true && saved.order?.[tier] === undefined)));
  }

  private statusText(status: 'ok' | 'error' | 'off', kind: ProviderEntry['kind']): string {
    if (status === 'ok') return this.text('잘 되고 있어요', 'Working');
    if (status === 'error') return this.text('키는 저장했지만 확인하지 못했어요', 'Saved but not checked');
    return kind === 'api_key' ? this.text('연결 안 됨', 'Not connected') : this.text('꺼져 있어요', 'Off');
  }

  private text(ko: string, en: string): string {
    return this.korean ? ko : en;
  }

  private async saved(): Promise<Saved> {
    return (await this.opts.kv.get<Saved>(KEY)) ?? {};
  }

  private async save(value: Saved): Promise<void> {
    await this.opts.kv.set(KEY, value);
  }
}
