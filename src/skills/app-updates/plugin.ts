import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';

/** One build this Mac hands out: the apps compare `build` with their own and offer the update. */
export interface BuildInfo {
  /** Only grows (the app repository's commit count). */
  build: number;
  versionName: string;
  builtAt: string;
  sha256: string;
  size: number;
}

export interface UpdatePaths {
  apk: string;
  apkInfo: string;
  desktopZip: string;
  desktopInfo: string;
}

export function updatePaths(home = join(homedir(), '.ax-kit')): UpdatePaths {
  return {
    apk: join(home, 'files', 'apk', 'ax-kit.apk'),
    apkInfo: join(home, 'files', 'apk', 'ax-kit.json'),
    desktopZip: join(home, 'dist', 'ax-kit-desktop.zip'),
    desktopInfo: join(home, 'dist', 'ax-kit-desktop.json'),
  };
}

/** Records what was just built (after a build), next to the file. */
export async function writeBuildInfo(file: string, infoFile: string, build: number, versionName: string): Promise<BuildInfo> {
  const bytes = await readFile(file);
  const info: BuildInfo = { build, versionName, builtAt: new Date().toISOString(), sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  await writeFile(infoFile, JSON.stringify(info, null, 2));
  return info;
}

/** The info for a file, only while the file itself is there (and the same size). */
async function current(file: string, infoFile: string): Promise<BuildInfo | undefined> {
  const raw = await readFile(infoFile, 'utf8').then((text) => JSON.parse(text) as Record<string, unknown>, () => undefined);
  const size = await stat(file).then((info) => info.size, () => undefined);
  if (raw === undefined || size === undefined || raw['size'] !== size) return undefined;
  // `phone apk` writes versionCode; the desktop build writes build
  const build = typeof raw['build'] === 'number' ? raw['build'] : typeof raw['versionCode'] === 'number' ? raw['versionCode'] : undefined;
  if (build === undefined) return undefined;
  return { build, versionName: String(raw['versionName'] ?? build), builtAt: String(raw['builtAt'] ?? ''), sha256: String(raw['sha256'] ?? ''), size };
}

/**
 * App updates without a store (§32): this Mac hands its own builds of the Android and Mac apps to the paired apps.
 * `views/app-updates` says what it has; the files come from `app-updates/android.apk` and `app-updates/desktop.zip`,
 * only to paired devices. An app with a lower build offers "새 버전으로 바꾸기".
 */
export function appUpdatesSkill(options: { paths?: UpdatePaths } = {}): Plugin {
  return {
    manifest: { id: 'skill.app-updates', kind: 'skill', title: 'App updates from this Mac' },
    setup(ctx) {
      const paths = options.paths ?? updatePaths();
      ctx.bus.on('app.started', () => {
        const views = ctx.tryUse(Contracts.appViews);
        views?.register({
          name: 'app-updates',
          version: 1,
          async read() {
            const [android, desktop] = await Promise.all([current(paths.apk, paths.apkInfo), current(paths.desktopZip, paths.desktopInfo)]);
            return { ...(android !== undefined ? { android } : {}), ...(desktop !== undefined ? { desktop } : {}) };
          },
        });
        views?.addFeature?.('app-updates');
        const api = ctx.tryUse(Contracts.deviceApi);
        const serve = (file: string, infoFile: string, contentType: string, name: string) => async () => {
          if ((await current(file, infoFile)) === undefined) return undefined;
          const bytes = await readFile(file).catch(() => undefined);
          return bytes === undefined ? undefined : { bytes, contentType, name };
        };
        api?.download('app-updates/android.apk', serve(paths.apk, paths.apkInfo, 'application/vnd.android.package-archive', 'ax-kit.apk'));
        api?.download('app-updates/desktop.zip', serve(paths.desktopZip, paths.desktopInfo, 'application/zip', 'ax-kit-desktop.zip'));
      });
    },
  };
}
