import { access } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { phoneStorePath, PHONE_NAMESPACE } from '../app/phone.js';
import type { Config } from '../core/config/schema.js';
import type { SecretStore } from '../core/secrets/types.js';
import { openSqliteStore } from '../core/store/sqlite.js';
import { KILL_MIGRATIONS, SqliteKillSwitch } from '../core/switches/kill.js';
import { isActive, readDevices } from '../mobile/devices.js';
import { defaultExec } from './doctor-phone.js';
import type { FeatureDeps } from './features.js';
import { LAUNCHD_LABEL } from './service.js';
import { tailscaleStatus } from './tailscale.js';

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

/** Looks in Homebrew's folders too: launchd and fresh shells often have a short PATH. */
export async function hasCommand(name: string): Promise<boolean> {
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(':')]) {
    if (dir !== '' && (await exists(`${dir}/${name}`))) return true;
  }
  return false;
}

export function nodeFeatureDeps(home: string, config: Config | undefined, secrets: SecretStore): FeatureDeps {
  const withStore = async <T>(fallback: T, use: (store: ReturnType<typeof openSqliteStore>) => Promise<T>): Promise<T> => {
    if (!(await exists(phoneStorePath(home)))) return fallback;
    const store = openSqliteStore(phoneStorePath(home));
    try {
      return await use(store);
    } catch {
      return fallback;
    } finally {
      await store.close();
    }
  };
  return {
    config,
    secrets,
    home,
    exists,
    hasCommand,
    launchdLoaded: async () => (await defaultExec('launchctl', ['print', `gui/${userInfo().uid}/${LAUNCHD_LABEL}`])).code === 0,
    pairedDevices: async () => await withStore(0, async (store) => (await readDevices(store.kv(PHONE_NAMESPACE))).filter(isActive).length),
    tailscaleUp: async () => (await tailscaleStatus(defaultExec)).running,
    stopped: async () =>
      await withStore(false, async (store) => {
        await store.migrate(KILL_MIGRATIONS);
        return (await new SqliteKillSwitch(store.sql, () => new Date()).state()).stopped;
      }),
  };
}
