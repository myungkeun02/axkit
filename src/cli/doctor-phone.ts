import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { KOREAN_PACK_KEYS } from '../app/ko-pack.js';
import { PHONE_KEYS, PHONE_NAMESPACE, phoneStorePath } from '../app/phone.js';
import type { SecretReader } from '../core/secrets/types.js';
import type { Store } from '../core/store/types.js';
import { openSqliteStore } from '../core/store/sqlite.js';
import type { MobileDevice } from '../mobile/index.js';
import type { DoctorCheck } from './doctor.js';
import { funnelServesPath, tailscaleStatus } from './tailscale.js';
import type { Exec, ExecResult } from './tailscale.js';

const FUNNEL_FIX = 'tailscale funnel --bg --set-path /m http://127.0.0.1:47617/m';
const FUNNEL_GUIDE_NOTE = 'see docs/guides/tailscale-funnel.md';

function errorCode(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return 1;
}

/** Spawns a command and resolves with its exit status instead of rejecting. */
export function defaultExec(cmd: string, args: readonly string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : errorCode(error), stdout, stderr });
    });
  });
}

async function ranOk(exec: Exec, cmd: string, args: readonly string[]): Promise<boolean> {
  try {
    return (await exec(cmd, args)).code === 0;
  } catch {
    return false;
  }
}

export async function tailscaleChecks(exec: Exec): Promise<DoctorCheck[]> {
  const status = await tailscaleStatus(exec);
  const funnel = status.installed && status.running ? await funnelServesPath(exec, '/m') : false;

  return [
    {
      id: 'tailscale.installed',
      ok: status.installed,
      severity: 'warn',
      detail: status.installed ? 'tailscale CLI found' : 'tailscale CLI not found',
      ...(status.installed ? {} : { fix: 'install Tailscale: brew install --cask tailscale' }),
    },
    {
      id: 'tailscale.running',
      ok: status.installed && status.running,
      severity: 'warn',
      detail: status.installed ? (status.running ? 'tailscale is running' : 'tailscale is not running') : 'not installed',
      ...(status.installed && status.running
        ? {}
        : { fix: 'open the Tailscale app and run: tailscale up' }),
    },
    {
      id: 'tailscale.funnel',
      ok: funnel,
      severity: 'warn',
      detail: funnel ? 'funnel serves /m' : `funnel does not serve /m (${FUNNEL_GUIDE_NOTE})`,
      ...(funnel ? {} : { fix: FUNNEL_FIX }),
    },
  ];
}

export async function shortcutsCheck(exec: Exec): Promise<DoctorCheck> {
  const ok = await ranOk(exec, 'shortcuts', ['--help']);
  return {
    id: 'shortcuts',
    ok,
    severity: 'warn',
    detail: ok ? 'shortcuts CLI available' : 'shortcuts CLI not found',
    ...(ok ? {} : { fix: 'open Shortcuts.app once, then retry: shortcuts --help' }),
  };
}

function ageText(iso: string, now: Date): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 'unknown';
  const minutes = Math.floor(Math.max(0, now.getTime() - parsed) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

async function readPhoneState(home: string): Promise<{
  devices: MobileDevice[];
  lastSeen?: string;
}> {
  const store: Store = openSqliteStore(phoneStorePath(home));
  try {
    const kv = store.kv(PHONE_NAMESPACE);
    const stored = await kv.get<MobileDevice[]>(PHONE_KEYS.devices);
    const devices = Array.isArray(stored) ? stored : [];
    const lastSeen = await kv.get<string>(PHONE_KEYS.lastSeen);
    return {
      devices,
      ...(typeof lastSeen === 'string' ? { lastSeen } : {}),
    };
  } finally {
    await store.close();
  }
}

export async function phoneCheck(home: string, now: Date): Promise<DoctorCheck> {
  try {
    await access(phoneStorePath(home));
  } catch {
    return {
      id: 'phone.devices',
      ok: false,
      severity: 'warn',
      detail: 'no phone paired yet',
      fix: 'run: ax-kit phone pair',
    };
  }

  try {
    const { devices, lastSeen } = await readPhoneState(home);
    if (devices.length === 0) {
      return {
        id: 'phone.devices',
        ok: false,
        severity: 'warn',
        detail: 'no phone paired yet',
        fix: 'run: ax-kit phone pair',
      };
    }
    const active = devices.filter((device) => device.revokedAt === undefined).length;
    const signal = lastSeen === undefined ? 'no signal yet' : ageText(lastSeen, now);
    return {
      id: 'phone.devices',
      ok: active > 0,
      severity: 'warn',
      detail: `${devices.length} device(s), ${active} active, last signal ${signal}`,
      ...(active > 0 ? {} : { fix: 'run: ax-kit phone pair' }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      id: 'phone.devices',
      ok: false,
      severity: 'warn',
      detail: `could not read phone data: ${message}`,
      fix: 'run: ax-kit start once to create the database',
    };
  }
}

/** Names only: doctor never reads a key's value into its output. */
export async function koreanPackChecks(secrets: SecretReader): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  for (const key of KOREAN_PACK_KEYS) {
    let present = false;
    try {
      present = (await secrets.get(key.secret)) !== undefined;
    } catch {
      present = false;
    }
    checks.push({
      id: `secret.${key.secret}`,
      ok: present,
      severity: 'warn',
      detail: `${key.secret} ${present ? 'present' : 'missing'} (${key.features})`,
      ...(present ? {} : { fix: `run: ax-kit secret set ${key.secret}` }),
    });
  }
  return checks;
}

const APP_NAMESPACE = 'channel.app';
const APP_PRESENCE_KEY = 'presence';
const APP_STALE_MS = 24 * 60 * 60_000;

/** The phone app's connection, from the presence row the daemon keeps (names and times only). */
export async function appChannelCheck(home: string, now: Date): Promise<DoctorCheck> {
  const fix = 'run: ax-kit phone apk, then ax-kit phone pair --app';
  try {
    await access(phoneStorePath(home));
  } catch {
    return { id: 'app.connection', ok: false, severity: 'warn', detail: 'phone app not paired yet', fix };
  }
  const store: Store = openSqliteStore(phoneStorePath(home));
  try {
    const stored = await store.kv(APP_NAMESPACE).get<Record<string, { name: string; lastSeenAt: string; streams: number }>>(APP_PRESENCE_KEY);
    const records = Object.values(stored ?? {});
    if (records.length === 0) return { id: 'app.connection', ok: false, severity: 'warn', detail: 'phone app has not connected yet', fix };
    const live = records.filter((record) => record.streams > 0).length;
    const latest = records.map((record) => record.lastSeenAt).sort().at(-1) ?? '';
    const fresh = now.getTime() - Date.parse(latest) < APP_STALE_MS;
    return {
      id: 'app.connection',
      ok: live > 0 || fresh,
      severity: 'warn',
      detail: `${records.length} app client(s), ${live} live now, last seen ${ageText(latest, now)}`,
      ...(live > 0 || fresh ? {} : { fix: 'open the app on the phone; check Settings → server address' }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: 'app.connection', ok: false, severity: 'warn', detail: `could not read app state: ${message}`, fix };
  } finally {
    await store.close();
  }
}
