import type { AppView, AppViewRegistry, DeviceApi } from '../../core/contracts/device-api.js';
import { ViewInputError } from '../../core/contracts/device-api.js';
import type { Logger } from '../../core/log/types.js';
import { PROTOCOL_VERSION } from './protocol.js';

/** Features every v1 server has; clients hide what is missing instead of probing endpoints. */
const FEATURES = ['chat', 'cards', 'notices', 'share', 'stream', 'events', 'views', 'card-options', 'card-reply', 'activity'] as const;
const VIEW_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Read-only views other plugins add for app screens beyond chat (docs/APP-PROTOCOL.md §5). */
export class AppViews implements AppViewRegistry {
  private readonly views = new Map<string, AppView>();
  /** Features that depend on setup found at start (e.g. "push" once an APNs key is there). */
  private readonly extraFeatures = new Set<string>();

  constructor(private readonly log: Logger) {}

  addFeature(name: string): void {
    this.extraFeatures.add(name);
  }

  /** What `capabilities` lists right now (R9's 기능 상태 screen reads it). */
  features(): string[] {
    return [...FEATURES, ...this.extraFeatures];
  }

  viewNames(): string[] {
    return [...this.views.keys()];
  }

  register(view: AppView): void {
    if (!VIEW_NAME.test(view.name)) throw new Error(`Invalid view name: ${view.name}`);
    if (this.views.has(view.name)) throw new Error(`View already registered: ${view.name}`);
    this.views.set(view.name, view);
  }

  mount(api: DeviceApi): void {
    api.route('GET', 'capabilities', async () => ({
      status: 200,
      body: {
        ok: true,
        protocol: PROTOCOL_VERSION,
        features: [...FEATURES, ...this.extraFeatures],
        views: [...this.views.values()].map((view) => ({
          name: view.name,
          version: view.version,
          actions: Object.keys(view.actions ?? {}),
          ...(view.ui !== undefined ? { ui: view.ui } : {}),
          ...(view.title !== undefined ? { title: view.title } : {}),
          ...(view.icon !== undefined ? { icon: view.icon } : {}),
        })),
      },
    }));
    api.route('GET', 'views/:name', async ({ params, query }) => {
      const view = this.views.get(params['name'] ?? '');
      if (view === undefined) return { status: 404, body: { ok: false, error: 'no_view' } };
      return this.guard(view.name, async () => ({ view: view.name, version: view.version, data: await view.read(query) }));
    });
    api.route('POST', 'views/:name/:action', async ({ params, body }) => {
      const view = this.views.get(params['name'] ?? '');
      const action = view?.actions?.[params['action'] ?? ''];
      if (view === undefined || action === undefined) return { status: 404, body: { ok: false, error: 'no_view' } };
      return this.guard(view.name, async () => ({ view: view.name, action: params['action'], data: await action(body) }));
    });
  }

  private async guard(name: string, run: () => Promise<Record<string, unknown>>) {
    try {
      return { status: 200, body: { ok: true, ...(await run()) } };
    } catch (error) {
      if (error instanceof ViewInputError) {
        return { status: 400, body: { ok: false, error: 'shape', ...(error.forOwner ? { message: error.message.slice(0, 300) } : {}) } };
      }
      this.log.warn('app: view failed', { view: name, error: error instanceof Error ? error.name : 'error' });
      return { status: 503, body: { ok: false, error: 'view_failed' } };
    }
  }
}
