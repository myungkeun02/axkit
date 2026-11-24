import { phoneStorePath, PHONE_NAMESPACE } from '../app/phone.js';
import type { ApnsTransport } from '../channels/app/apns.js';
import { createApnsSender } from '../channels/app/apns.js';
import { appTexts } from '../channels/app/locale.js';
import { dropsToken, loadApnsCredentials, pushConfig, PushRegistry, testPushPayload } from '../channels/app/push.js';
import type { Config } from '../core/config/schema.js';
import { systemClock } from '../core/scheduler/clock.js';
import type { SecretReader } from '../core/secrets/types.js';
import { openSqliteStore } from '../core/store/sqlite.js';
import { isActive, readDevices } from '../mobile/devices.js';

const APP_NAMESPACE = 'channel.app';

export interface PushTestDeps {
  home: string;
  config: Config;
  secrets: SecretReader;
  say(line: string): void;
  /** Tests answer APNs without a network request. */
  transport?: ApnsTransport;
}

/**
 * `ax-kit phone push-test [<device id>]`: one test push to each registered phone (or the one named), from the
 * keychain key, without the daemon. Prints device ids and Apple's answer only, never a token or key.
 */
export async function pushTestCommand(deps: PushTestDeps, deviceId?: string): Promise<number> {
  const config = pushConfig(deps.config.plugins['channel.app'] ?? {});
  const credentials = await loadApnsCredentials(deps.secrets, config);
  if (credentials === undefined) {
    deps.say('APNs 키가 없어요. `ax-kit secret set app.apns.key`(.p8 내용), `app.apns.key-id`, `app.apns.team-id`를 넣어 주세요.');
    return 1;
  }
  const store = openSqliteStore(phoneStorePath(deps.home));
  const sender = createApnsSender({
    credentials: async () => credentials,
    clock: systemClock,
    ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
  });
  try {
    const registry = new PushRegistry(store.kv(APP_NAMESPACE), systemClock);
    const devices = await readDevices(store.kv(PHONE_NAMESPACE));
    const targets = Object.entries(await registry.all()).filter(([id]) => deviceId === undefined || id === deviceId);
    if (targets.length === 0) {
      deps.say('푸시를 등록한 폰이 없어요. 폰 앱을 열어 알림을 허용해 주세요.');
      return 1;
    }
    const texts = appTexts(deps.config.assistant.language);
    let failed = 0;
    for (const [id, registration] of targets) {
      const device = devices.find((candidate) => candidate.id === id);
      if (device === undefined || !isActive(device)) {
        await registry.remove(id);
        deps.say(`${id}: 연결이 해제된 기기라 토큰을 지웠어요`);
        failed += 1;
        continue;
      }
      const result = await sender.send(registration, testPushPayload(texts, deps.config.assistant.name, 0));
      if (dropsToken(result)) await registry.remove(id);
      deps.say(`${id} (${device.name}): ${result.status}${result.reason !== undefined ? ` ${result.reason}` : ''}`);
      if (result.status !== 200) failed += 1;
    }
    return failed === 0 ? 0 : 1;
  } finally {
    sender.close();
    await store.close();
  }
}
