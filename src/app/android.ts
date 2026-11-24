import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessRunner } from '../core/process/types.js';
import type { SecretStore } from '../core/secrets/types.js';

/** Keychain name of the release keystore password. The value is never printed or written to a file. */
export const KEYSTORE_SECRET = 'android.keystore-password';
const KEY_ALIAS = 'ax-kit';
const BUILD_TIMEOUT_MS = 30 * 60_000;
const KEYTOOL_TIMEOUT_MS = 60_000;

/** The Android app: its own repository next to ax-kit (~/ax-kit-apps/ax-kit-android), else an android/ folder here. */
export const ANDROID_DIR = existsSync(join(homedir(), 'ax-kit-apps', 'ax-kit-android', 'gradlew'))
  ? join(homedir(), 'ax-kit-apps', 'ax-kit-android')
  : fileURLToPath(new URL('../../android', import.meta.url));

/** What `phone apk` built last, next to the APK: the apps compare it with their own version to offer an update. */
export interface ApkInfo {
  versionCode: number;
  versionName: string;
  builtAt: string;
  sha256: string;
  size: number;
}

export function apkInfoPath(home: string): string {
  return join(home, 'files', 'apk', 'ax-kit.json');
}

export async function readApkInfo(home: string): Promise<ApkInfo | undefined> {
  return await readFile(apkInfoPath(home), 'utf8').then((text) => JSON.parse(text) as ApkInfo, () => undefined);
}

export interface AndroidPaths {
  keystore: string;
  /** Where `phone apk` keeps the last built APK, outside the checkout. */
  apk: string;
  buildOutput: string;
}

export function androidPaths(home: string, androidDir = ANDROID_DIR): AndroidPaths {
  return {
    keystore: join(home, 'android', 'release.jks'),
    apk: join(home, 'files', 'apk', 'ax-kit.apk'),
    buildOutput: join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk'),
  };
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface AndroidDeps {
  home: string;
  secrets: SecretStore;
  run: ProcessRunner;
  androidDir?: string;
  /** Wraps the Gradle call (a machine-wide build lock); empty means run Gradle directly. */
  buildLock?: string;
}

/**
 * Makes this Mac's own signing key once. Updates must be signed with the same key, so it lives in ~/.ax-kit and the
 * password in the Keychain; keytool reads it from the environment so it never shows in the process list.
 */
export async function ensureSigningKey(deps: AndroidDeps): Promise<'created' | 'exists'> {
  const paths = androidPaths(deps.home, deps.androidDir);
  const hasPassword = await deps.secrets.has(KEYSTORE_SECRET);
  if (hasPassword && (await fileExists(paths.keystore))) return 'exists';
  if (await fileExists(paths.keystore)) {
    throw new Error(`Keystore exists but its password is missing from the Keychain (${KEYSTORE_SECRET}). Move ${paths.keystore} away to make a new key.`);
  }
  const password = randomBytes(24).toString('base64url');
  await mkdir(join(deps.home, 'android'), { recursive: true, mode: 0o700 });
  await chmod(join(deps.home, 'android'), 0o700);
  const result = await deps.run(
    'keytool',
    [
      '-genkeypair', '-keystore', paths.keystore, '-storetype', 'PKCS12', '-alias', KEY_ALIAS,
      '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000', '-dname', 'CN=ax-kit',
      '-storepass:env', 'AXKIT_KS_PASS', '-keypass:env', 'AXKIT_KS_PASS',
    ],
    { env: { AXKIT_KS_PASS: password }, timeoutMs: KEYTOOL_TIMEOUT_MS },
  );
  if (result.code !== 0) throw new Error(`keytool failed (exit ${result.code})`);
  await chmod(paths.keystore, 0o600);
  await deps.secrets.set(KEYSTORE_SECRET, password);
  return 'created';
}

/** Builds the signed release APK and copies it to ~/.ax-kit/files/apk. Returns the copied path. */
export async function buildReleaseApk(deps: AndroidDeps): Promise<string> {
  const androidDir = deps.androidDir ?? ANDROID_DIR;
  const paths = androidPaths(deps.home, androidDir);
  await ensureSigningKey(deps);
  const password = await deps.secrets.get(KEYSTORE_SECRET);
  if (password === undefined) throw new Error(`Missing Keychain item ${KEYSTORE_SECRET}`);
  // a version that only grows (the app repository's commit count), so a phone can tell a newer build and update over it
  const counted = await deps.run('git', ['-C', androidDir, 'rev-list', '--count', 'HEAD'], { timeoutMs: 10_000 }).catch(() => undefined);
  const versionCode = Math.max(1, Number.parseInt(counted?.stdout.trim() ?? '', 10) || 1);
  const versionName = `1.0.${versionCode}`;
  const java = ['/opt/homebrew/opt/openjdk@17', '/usr/local/opt/openjdk@17'].find((dir) => existsSync(join(dir, 'bin', 'java')));
  const sdk = ['/opt/homebrew/share/android-commandlinetools', '/usr/local/share/android-commandlinetools'].find((dir) => existsSync(join(dir, 'platforms')));
  const gradle = ['./gradlew', '--no-daemon', '-q', 'assembleRelease'];
  const [cmd, ...args] = deps.buildLock !== undefined && deps.buildLock !== '' ? ['lockf', '-k', deps.buildLock, ...gradle] : gradle;
  const result = await deps.run(cmd ?? './gradlew', args, {
    cwd: androidDir,
    env: {
      AXKIT_KEYSTORE: paths.keystore,
      AXKIT_KEYSTORE_PASSWORD: password,
      AXKIT_KEY_ALIAS: KEY_ALIAS,
      AXKIT_VERSION_CODE: String(versionCode),
      AXKIT_VERSION_NAME: versionName,
      ...(java !== undefined ? { JAVA_HOME: java, PATH: `${java}/bin:${process.env['PATH'] ?? '/usr/bin:/bin'}` } : {}),
      ...(sdk !== undefined ? { ANDROID_HOME: sdk } : {}),
    },
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  if (result.code !== 0) {
    throw new Error(`Gradle build failed (exit ${result.code}): ${result.stderr.slice(-800)}`);
  }
  await mkdir(join(deps.home, 'files', 'apk'), { recursive: true, mode: 0o700 });
  await copyFile(paths.buildOutput, paths.apk);
  const bytes = await readFile(paths.apk);
  const info: ApkInfo = { versionCode, versionName, builtAt: new Date().toISOString(), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  await writeFile(apkInfoPath(deps.home), JSON.stringify(info, null, 2));
  return paths.apk;
}
