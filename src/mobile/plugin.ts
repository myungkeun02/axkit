import { Contracts } from '../core/contracts/index.js';
import type { Plugin } from '../core/plugin/types.js';
import { MobileAdmin } from './admin.js';
import { AuthGate } from './auth.js';
import { resolveMobileConfig } from './config.js';
import { MobileIngest } from './ingest.js';
import { mobileTexts } from './locale.js';
import { registerMobileMaintenance } from './maintenance.js';
import { OtpVault } from './otp.js';
import { SampleStore } from './samples.js';
import { startBridgeServer } from './server.js';
import type { BridgeServerDeps, BridgeServerHandle } from './server.js';
import { SmsActions } from './sms-action.js';
import { AppRouter } from './app-api.js';
import { ApkLinks } from './apk-links.js';
import { InstallLinks } from './install-links.js';
import { registerAppSelfRoutes } from './app-self.js';
import { newToken } from './devices.js';
import { isLoopbackHost, writeLocalToken } from './local-token.js';

/** After the server's own 30 tries, the port is tried again this often until it is free. */
const LISTEN_AGAIN_MS = 60_000;

export interface MobileBridgeOptions {
  /** Tests and the CLI pair/rotate flow keep the socket closed. */
  listen?: boolean;
  /** Tests listen on port 0 and learn the real port here. */
  onListening?: (port: number) => void;
  /** ~/.ax-kit/desktop.token: a fresh local token for the desktop app on this Mac, written on every start. */
  localTokenFile?: string;
}

/**
 * Receives phone signals over HTTP, keeps them local, and exposes them as capabilities and events.
 * Pairing, rotation, revocation and file generation are driven by the CLI through `MobileAdmin`.
 */
export function mobileBridge(options: MobileBridgeOptions = {}): Plugin {
  return {
    manifest: {
      id: 'bridge.mobile',
      kind: 'bridge',
      title: 'Phone bridge',
    },
    setup(ctx) {
      const config = resolveMobileConfig(ctx.config);
      if (config.usedDefaults) ctx.log.warn('mobile: invalid config, using defaults');
      if (config.forcedLoopback) ctx.log.warn('mobile: all-interface host refused; listening on 127.0.0.1');

      const texts = mobileTexts(ctx.assistant.language);
      const admin = new MobileAdmin({ kv: ctx.kv, clock: ctx.clock });
      const auth = new AuthGate({
        kv: ctx.kv,
        clock: ctx.clock,
        log: ctx.log,
        onLocked: async (device) => {
          const notifier = ctx.tryUse(Contracts.notifier);
          if (notifier === undefined) {
            ctx.log.warn('mobile: device locked but no notifier is available', { deviceId: device.id });
            return;
          }
          await notifier.notify({
            kind: 'phone.device_locked',
            urgent: true,
            dedupeKey: `phone.lock:${device.id}:${device.lockedAt ?? ''}`,
            text: texts.lockNotice(device),
          });
        },
      });
      const samples = new SampleStore(ctx.kv, ctx.clock, ctx.assistant.timezone);
      const otp = new OtpVault(ctx.clock);
      const sms = new SmsActions({
        kv: ctx.kv,
        llm: ctx.llm,
        clock: ctx.clock,
        log: ctx.log,
        texts,
        notifier: () => ctx.tryUse(Contracts.notifier),
        todo: () => ctx.tryUse(Contracts.todoWrite),
      });
      const ingest = new MobileIngest({
        samples,
        otp,
        sms,
        bus: ctx.bus,
        log: ctx.log,
        reader: () => ctx.tryUse(Contracts.smsReader),
      });

      ctx.provide(Contracts.phoneSignals, samples);
      ctx.provide(Contracts.phoneOtp, otp);
      const app = new AppRouter(ctx.log, async (deviceId) => {
        const device = await admin.get(deviceId);
        return device !== undefined && device.revokedAt === undefined;
      });
      registerAppSelfRoutes(app, admin, async (deviceId) => {
        await ctx.bus.emit('phone.device_revoked', { deviceId });
      });
      ctx.provide(Contracts.deviceApi, app);
      ctx.registerHandler(sms.handler());
      registerMobileMaintenance(ctx, admin, texts);

      const deps: BridgeServerDeps = {
        admin,
        app,
        apk: new ApkLinks(ctx.kv, ctx.clock),
        install: new InstallLinks(ctx.kv, ctx.clock),
        auth,
        ingest,
        clock: ctx.clock,
        log: ctx.log,
        texts,
        timeZone: ctx.assistant.timezone,
      };
      let server: BridgeServerHandle | undefined;
      let retry: ReturnType<typeof ctx.clock.setTimeout> | undefined;
      let stopped = false;
      return {
        async start() {
          if (options.listen === false) return;
          stopped = false;
          await listen();
        },
        async stop() {
          stopped = true;
          if (retry !== undefined) ctx.clock.clearTimeout(retry);
          retry = undefined;
          if (server !== undefined) {
            await server.close();
            server = undefined;
          }
        },
      };

      async function listen(): Promise<void> {
        const handle = await startBridgeServer(deps, {
          host: config.host,
          port: config.port,
          clock: ctx.clock,
          log: ctx.log,
        });
        if (stopped) {
          await handle?.close();
          return;
        }
        if (handle === undefined) {
          // the port is still held (an old copy shutting down, a second copy): keep trying, the phones need it
          ctx.log.error('mobile: bridge server did not start; the rest of the app keeps running, trying again in a minute');
          retry = ctx.clock.setTimeout(() => {
            retry = undefined;
            void listen();
          }, LISTEN_AGAIN_MS);
          return;
        }
        server = handle;
        if (options.localTokenFile !== undefined) {
          if (isLoopbackHost(config.host)) {
            const token = newToken();
            auth.setLocalToken(token);
            await writeLocalToken(options.localTokenFile, { baseUrl: `http://127.0.0.1:${handle.port}`, token, now: ctx.clock.now() })
              .catch((error: unknown) => {
                auth.setLocalToken(undefined);
                ctx.log.warn('mobile: desktop token not written', { error: error instanceof Error ? error.name : 'error' });
              });
          } else {
            ctx.log.info('mobile: bridge is not on loopback; the desktop app pairs instead of using a local token');
          }
        }
        options.onListening?.(handle.port);
        ctx.log.info('mobile: bridge listening', { port: handle.port });
      }
    },
  };
}
