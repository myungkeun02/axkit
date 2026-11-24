import type { Notice, NoticeResult, Notifier } from '../../src/core/contracts/index.js';
import type { MobileDevice, RandomBytes } from '../../src/mobile/devices.js';
import { readDevices } from '../../src/mobile/devices.js';
import type { KeyValueStore } from '../../src/core/store/types.js';
import { AuthGate } from '../../src/mobile/auth.js';
import { MobileAdmin } from '../../src/mobile/admin.js';
import { AppRouter } from '../../src/mobile/app-api.js';
import { mobileTexts } from '../../src/mobile/locale.js';
import { startBridgeServer } from '../../src/mobile/server.js';
import type { BridgeServerHandle } from '../../src/mobile/server.js';
import type { IngestItem } from '../../src/mobile/schema.js';
import type { IngestHandler } from '../../src/mobile/ingest.js';
import { createTestContext } from '../support/context.js';
import type { FakeClock } from '../core/helpers.js';

export const NOW = new Date('2026-11-17T09:00:00+09:00');

/** Deterministic bytes for ids, tokens and codes. Not cryptographic; tests only. */
export function seededRandom(seed = 1): RandomBytes {
  let state = seed >>> 0;
  return (size) => {
    const buffer = Buffer.alloc(size);
    for (let index = 0; index < size; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      buffer[index] = state & 0xff;
    }
    return buffer;
  };
}

export function wrongCode(code: string): string {
  const candidate = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  return candidate === code ? '000000' : candidate;
}

export async function patchDevice(
  kv: KeyValueStore,
  id: string,
  patch: Partial<MobileDevice>,
): Promise<void> {
  const devices = await readDevices(kv);
  await kv.set(
    'devices',
    devices.map((device) => (device.id === id ? { ...device, ...patch } : device)),
  );
}

export class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  result: NoticeResult = 'sent';

  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return this.result;
  }
}

export class RecordingIngest implements IngestHandler {
  readonly calls: { device: MobileDevice; at: Date; items: readonly IngestItem[] }[] = [];

  async handle(device: MobileDevice, at: Date, items: readonly IngestItem[]): Promise<number> {
    this.calls.push({ device, at, items });
    return items.length;
  }
}

export interface BridgeHarness {
  admin: MobileAdmin;
  app: AppRouter;
  auth: AuthGate;
  ingest: RecordingIngest;
  notifier: FakeNotifier;
  clock: FakeClock;
  port: number;
  close(): Promise<void>;
}

export interface BridgeHarnessOptions {
  now?: Date;
  notifier?: FakeNotifier;
  app?: AppRouter;
}

export async function startBridgeHarness(options: BridgeHarnessOptions = {}): Promise<BridgeHarness> {
  const context = createTestContext({ now: options.now ?? NOW });
  const notifier = options.notifier ?? new FakeNotifier();
  const texts = mobileTexts('ko');
  const admin = new MobileAdmin({ kv: context.kv, clock: context.clock, randomBytes: seededRandom(11) });
  const auth = new AuthGate({
    kv: context.kv,
    clock: context.clock,
    log: context.ctx.log,
    onLocked: async (device) => {
      await notifier.notify({
        kind: 'phone.device_locked',
        urgent: true,
        text: texts.lockNotice(device),
      });
    },
  });
  const ingest = new RecordingIngest();
  const app = options.app ?? new AppRouter(context.ctx.log);
  const handle: BridgeServerHandle | undefined = await startBridgeServer(
    { admin, app, auth, ingest, clock: context.clock, log: context.ctx.log, texts, timeZone: 'Asia/Seoul' },
    { host: '127.0.0.1', port: 0, clock: context.clock, log: context.ctx.log },
  );
  if (handle === undefined) throw new Error('test bridge server did not start');
  return {
    admin,
    app,
    auth,
    ingest,
    notifier,
    clock: context.clock,
    port: handle.port,
    close: handle.close,
  };
}

export function bridgeFetch(
  harness: BridgeHarness,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${harness.port}${path}`, init);
}

export function ingestRequest(token: string, body: string | Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}
