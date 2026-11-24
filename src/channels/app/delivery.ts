import type { DeviceApi, DeviceFile } from '../../core/contracts/device-api.js';
import type { AppFileShare } from '../../core/contracts/files.js';
import type { OutgoingImage } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ApnsTransport } from './apns.js';
import { createApnsSender } from './apns.js';
import type { ApnsSender } from './apns.js';
import { appFileShare } from './file-share.js';
import { AppFiles, mediaWithoutFiles } from './files.js';
import type { AppTexts } from './locale.js';
import type { AppEventLog } from './log.js';
import type { Presence } from './presence.js';
import type { EventMedia } from './protocol.js';
import { PushDispatcher, PushRegistry, loadApnsCredentials, pushConfig, registerPushRoutes } from './push.js';

export interface DeliveryOptions {
  ctx: PluginContext;
  api: DeviceApi;
  log: AppEventLog;
  presence: Presence;
  texts: AppTexts;
  /** ~/.ax-kit/files/app; without it only https pictures reach the app. */
  filesDir?: string;
  /** Tests answer APNs without a network request. */
  apnsTransport?: ApnsTransport;
  /** Other files under `files/:id` that are never pruned (bot pictures). */
  extraFiles?: (id: string) => Promise<DeviceFile | undefined>;
  /** Called once push is set up, so `capabilities.features` can list "push". */
  onPushReady: () => void;
}

export interface AppDelivery {
  media(images: readonly OutgoingImage[] | undefined): Promise<EventMedia>;
  /** §19 documents sent to the owner; absent without a files folder. */
  share: AppFileShare | undefined;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Tests wait for queued pushes. */
  flush(): Promise<void>;
}

const PRUNE_EVERY_SECONDS = 60 * 60;

/**
 * What the app gets beyond the event log itself: pictures served at `files/<id>` (§7.5) and APNs pushes (§7.7).
 * Push turns on only when the keychain holds an APNs key with its key id and team id.
 */
export function setupDelivery(options: DeliveryOptions): AppDelivery {
  const { ctx, api, log, presence, texts } = options;
  const files = options.filesDir !== undefined ? new AppFiles(options.filesDir, ctx.clock) : undefined;
  if (files !== undefined) {
    api.download('files/:id', async ({ params }) => {
      const id = params['id'] ?? '';
      return (await options.extraFiles?.(id)) ?? (await files.read(id));
    });
  }

  const config = pushConfig(ctx.config);
  const registry = new PushRegistry(ctx.kv, ctx.clock);
  let dispatcher: PushDispatcher | undefined;
  let sender: ApnsSender | undefined;
  let unsubscribe: (() => void) | undefined;
  registerPushRoutes(api, { registry, dispatcher: () => dispatcher });
  ctx.bus.on('phone.device_revoked', async ({ deviceId }) => {
    await registry.remove(deviceId);
  });

  const openCardFiles = async (): Promise<Set<string>> => {
    const open = new Set(await log.openCards());
    const events = await log.after(0, 500);
    return new Set(
      events.flatMap((event) =>
        event.type === 'card' && open.has(event.cardId) ? (event.attachments ?? []).map((attachment) => attachment.id) : [],
      ),
    );
  };
  const prune = async (): Promise<void> => {
    if (files === undefined) return;
    await files.prune(await openCardFiles());
  };
  if (files !== undefined) ctx.scheduler.add({ name: 'app.files.prune', schedule: { kind: 'every', seconds: PRUNE_EVERY_SECONDS }, run: prune });

  return {
    share: files !== undefined ? appFileShare(files, log) : undefined,
    media: async (images) => (files !== undefined ? await files.media(images) : await mediaWithoutFiles(images)),
    async start() {
      await prune().catch(() => undefined);
      if ((await loadApnsCredentials(ctx.secrets, config)) === undefined) return;
      sender = createApnsSender({
        credentials: () => loadApnsCredentials(ctx.secrets, config),
        clock: ctx.clock,
        ...(options.apnsTransport !== undefined ? { transport: options.apnsTransport } : {}),
      });
      dispatcher = new PushDispatcher({
        registry,
        sender,
        hasStream: (deviceId) => presence.hasStream(deviceId),
        deviceActive: (deviceId) => api.deviceActive(deviceId),
        openCards: async () => (await log.openCards()).length,
        assistantName: ctx.assistant.name,
        texts,
        hideContent: config.hideContent,
        clock: ctx.clock,
        log: ctx.log,
      });
      const active = dispatcher;
      unsubscribe = log.subscribe((event) => {
        active.handle(event);
      });
      options.onPushReady();
      ctx.log.info('app: push ready');
    },
    async stop() {
      unsubscribe?.();
      await dispatcher?.flush();
      sender?.close();
    },
    async flush() {
      await dispatcher?.flush();
    },
  };
}
