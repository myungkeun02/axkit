import type { DeviceApi } from '../../core/contracts/device-api.js';
import type { Logger } from '../../core/log/types.js';
import type { Clock } from '../../core/scheduler/types.js';
import type { SecretReader } from '../../core/secrets/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import type { ApnsCredentials, ApnsEnvironment, ApnsResult, ApnsSender } from './apns.js';
import { validCredentials } from './apns.js';
import type { AppTexts } from './locale.js';
import type { AppEvent } from './protocol.js';
import { pushRegisterSchema } from './protocol.js';

/**
 * APNs push for the iOS app (docs/APP-PROTOCOL.md §7.7): a new card, assistant message or
 * notice in the app log wakes each registered phone that has no open stream. Quiet hours and the daily notice budget
 * were already applied before the event reached the log.
 */
export const PUSH_KEY = 'push';
/** Keychain names; the key id and team id may instead sit in config (`plugins["channel.app"].push`). */
export const APNS_SECRETS = { key: 'app.apns.key', keyId: 'app.apns.key-id', teamId: 'app.apns.team-id' } as const;

const MAX_BODY_CHARS = 80;
const NON_CARD_PER_HOUR = 30;
const HOUR_MS = 60 * 60_000;
const DROP_REASONS = new Set(['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered']);
export const CARD_CATEGORY = 'AX_CARD';

export interface PushRegistration {
  token: string;
  environment: ApnsEnvironment;
  topic: string;
  registeredAt: string;
}

export interface PushConfig {
  keyId?: string;
  teamId?: string;
  /** Lock screens show only "new notification", never the text. */
  hideContent: boolean;
}

export function pushConfig(pluginConfig: Readonly<Record<string, unknown>>): PushConfig {
  const raw = pluginConfig['push'];
  const section = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);
  const keyId = text(section['keyId']);
  const teamId = text(section['teamId']);
  return {
    ...(keyId !== undefined ? { keyId } : {}),
    ...(teamId !== undefined ? { teamId } : {}),
    hideContent: section['hideContent'] === true,
  };
}

async function readSecret(secrets: SecretReader, name: string): Promise<string | undefined> {
  try {
    const value = await secrets.get(name);
    return value === undefined || value.trim() === '' ? undefined : value.trim();
  } catch {
    return undefined;
  }
}

/** The .p8 key from the keychain, its ids from config or the keychain; undefined when any is missing or malformed. */
export async function loadApnsCredentials(secrets: SecretReader, config: PushConfig): Promise<ApnsCredentials | undefined> {
  const key = await readSecret(secrets, APNS_SECRETS.key);
  const keyId = config.keyId ?? (await readSecret(secrets, APNS_SECRETS.keyId));
  const teamId = config.teamId ?? (await readSecret(secrets, APNS_SECRETS.teamId));
  const candidate = { key, keyId, teamId };
  return validCredentials(candidate) ? candidate : undefined;
}

/** One phone's APNs token per device; kept in kv so `ax-kit phone push-test` can read it from another process. */
export class PushRegistry {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly clock: Clock,
  ) {}

  async all(): Promise<Record<string, PushRegistration>> {
    const stored = await this.kv.get<Record<string, PushRegistration>>(PUSH_KEY);
    return typeof stored === 'object' && stored !== null ? stored : {};
  }

  async get(deviceId: string): Promise<PushRegistration | undefined> {
    return (await this.all())[deviceId];
  }

  /** Overwrites the device's token; the same token on another device (a re-pair) moves here. */
  async register(deviceId: string, input: Omit<PushRegistration, 'registeredAt'>): Promise<void> {
    const kept = Object.entries(await this.all()).filter(([, registration]) => registration.token !== input.token);
    const all = Object.fromEntries(kept);
    all[deviceId] = { ...input, registeredAt: this.clock.now().toISOString() };
    await this.kv.set(PUSH_KEY, all);
  }

  async remove(deviceId: string): Promise<boolean> {
    const all = await this.all();
    if (all[deviceId] === undefined) return false;
    await this.kv.set(PUSH_KEY, Object.fromEntries(Object.entries(all).filter(([id]) => id !== deviceId)));
    return true;
  }
}

/** Markdown → one plain line, clipped to 80 characters. */
export function pushText(input: string, max = MAX_BODY_CHARS): string {
  const text = input
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<@[!&]?[^>]*>/g, ' ')
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*#{1,6}\s*/, '').replace(/^\s*>\s?/, '').replace(/^\s*[-*+]\s+/, ''))
    .join(' ')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

export interface PushPlan {
  payload: Record<string, unknown>;
  card: boolean;
  collapseId?: string;
}

export interface PlanOptions {
  assistantName: string;
  texts: AppTexts;
  hideContent: boolean;
  badge: number;
}

/** What a log event looks like on the lock screen; undefined = no push (the owner's own lines, closed cards). */
export function pushPlan(event: AppEvent, options: PlanOptions): PushPlan | undefined {
  // a hand-off line is not worth waking the phone for; the bot's answer in its room is
  if (event.type === 'card_closed' || event.type === 'delegation') return undefined;
  if (event.type === 'message' && event.role === 'owner') return undefined;
  const { texts } = options;
  const pictures = (event.attachments?.length ?? 0) > 0 || event.imageUrl !== undefined;
  const body = (text: string): string => {
    if (options.hideContent) return texts.push.hidden;
    const plain = pushText(text);
    return plain === '' && pictures ? texts.push.picture : plain;
  };
  const aps = (title: string, text: string): Record<string, unknown> => ({
    alert: { title, body: body(text) },
    sound: 'default',
    badge: options.badge,
    'thread-id': 'chat',
  });
  if (event.type === 'card') {
    return {
      card: true,
      collapseId: `card:${event.cardId}`.slice(0, 64),
      payload: {
        aps: { ...aps(texts.push.cardTitle, event.summary), 'interruption-level': 'time-sensitive', category: CARD_CATEGORY },
        seq: event.seq,
        channel: '',
        cardId: event.cardId,
        // ax-kit cards are always approve / deny: the app answers lock-screen buttons with `{decision}`.
        decision: true,
        approveLabel: texts.push.approve,
        denyLabel: texts.push.deny,
      },
    };
  }
  const author = event.type === 'message' ? event.author?.name : undefined;
  const title = event.type === 'message' ? (author ?? options.assistantName) : texts.push.noticeTitle(options.assistantName);
  const channel = event.type === 'message' ? (event.channel ?? '') : '';
  return { card: false, payload: { aps: aps(title, event.text), seq: event.seq, channel } };
}

export function testPushPayload(texts: AppTexts, assistantName: string, badge: number): Record<string, unknown> {
  return { aps: { alert: { title: assistantName, body: texts.push.testBody }, sound: 'default', badge }, seq: 0, channel: '' };
}

export function dropsToken(result: ApnsResult): boolean {
  return result.status === 410 || (result.status === 400 && result.reason !== undefined && DROP_REASONS.has(result.reason));
}

export interface PushDispatcherOptions {
  registry: PushRegistry;
  sender: ApnsSender;
  /** The app is on screen (an open stream): the event already reached it. */
  hasStream(deviceId: string): boolean;
  /** Revoked from the CLI in another process → its token is dropped before anything is sent. */
  deviceActive(deviceId: string): Promise<boolean>;
  openCards(): Promise<number>;
  assistantName: string;
  texts: AppTexts;
  hideContent: boolean;
  clock: Clock;
  log: Logger;
}

export class PushDispatcher {
  private readonly sent = new Map<string, number[]>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly options: PushDispatcherOptions) {}

  /** Queued so pushes go out in log order without blocking the writer. */
  handle(event: AppEvent): void {
    this.chain = this.chain
      .then(() => this.deliver(event))
      .catch((error: unknown) => {
        this.options.log.warn('app: push failed', { error: error instanceof Error ? error.name : 'error' });
      });
  }

  /** Waits for queued pushes (tests and shutdown). */
  async flush(): Promise<void> {
    await this.chain;
  }

  /** `POST push/test` and the CLI: one test push to one phone, whatever the stream state. */
  async sendTest(deviceId: string): Promise<ApnsResult | undefined> {
    const registration = await this.options.registry.get(deviceId);
    if (registration === undefined) return undefined;
    const payload = testPushPayload(this.options.texts, this.options.assistantName, await this.options.openCards());
    return await this.send(deviceId, registration, payload, {});
  }

  private async deliver(event: AppEvent): Promise<void> {
    const registrations = Object.entries(await this.options.registry.all());
    if (registrations.length === 0) return;
    const plan = pushPlan(event, {
      assistantName: this.options.assistantName,
      texts: this.options.texts,
      hideContent: this.options.hideContent,
      badge: await this.options.openCards(),
    });
    if (plan === undefined) return;
    for (const [deviceId, registration] of registrations) {
      if (this.options.hasStream(deviceId)) continue;
      if (!plan.card && !this.withinLimit(deviceId)) continue;
      await this.send(deviceId, registration, plan.payload, plan.card ? { priority: 10, ...(plan.collapseId ? { collapseId: plan.collapseId } : {}) } : {});
    }
  }

  private async send(
    deviceId: string,
    registration: PushRegistration,
    payload: Record<string, unknown>,
    sendOptions: { priority?: 5 | 10; collapseId?: string },
  ): Promise<ApnsResult> {
    if (!(await this.options.deviceActive(deviceId))) {
      await this.options.registry.remove(deviceId);
      return { status: 0, reason: 'unpaired' };
    }
    const result = await this.options.sender.send(
      { token: registration.token, environment: registration.environment, topic: registration.topic },
      payload,
      sendOptions,
    );
    this.options.log.info('app: push', { deviceId, status: result.status, ...(result.reason !== undefined ? { reason: result.reason } : {}) });
    if (dropsToken(result)) await this.options.registry.remove(deviceId);
    return result;
  }

  /** Messages and notices: at most 30 per device per rolling hour; cards always go. */
  private withinLimit(deviceId: string): boolean {
    const now = this.options.clock.now().getTime();
    const recent = (this.sent.get(deviceId) ?? []).filter((at) => at > now - HOUR_MS);
    const allowed = recent.length < NON_CARD_PER_HOUR;
    if (allowed) recent.push(now);
    this.sent.set(deviceId, recent);
    return allowed;
  }
}

export interface PushRouteDeps {
  registry: PushRegistry;
  /** Undefined while no APNs key is set up: registering still works, a test push answers `push_off`. */
  dispatcher: () => PushDispatcher | undefined;
}

export function registerPushRoutes(api: DeviceApi, deps: PushRouteDeps): void {
  api.route('POST', 'push/register', async ({ caller, body }) => {
    const parsed = pushRegisterSchema.safeParse(body);
    if (!parsed.success) return { status: 400, body: { ok: false, error: 'shape' } };
    await deps.registry.register(caller.deviceId, {
      token: parsed.data.token.toLowerCase(),
      environment: parsed.data.environment,
      topic: parsed.data.topic,
    });
    return { status: 200, body: { ok: true } };
  });
  api.route('POST', 'push/test', async ({ caller }) => {
    const dispatcher = deps.dispatcher();
    if (dispatcher === undefined) return { status: 503, body: { ok: false, error: 'push_off' } };
    const result = await dispatcher.sendTest(caller.deviceId);
    if (result === undefined) return { status: 404, body: { ok: false, error: 'not_registered' } };
    return {
      status: 200,
      body: { ok: result.status === 200, status: result.status, ...(result.reason !== undefined ? { reason: result.reason } : {}) },
    };
  });
}
