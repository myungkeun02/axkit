import { access, copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProcessRunner } from '../../core/process/types.js';
import { findAndroidSdk, findJavaHome } from '../../core/process/toolchains.js';
import { updatePaths, writeBuildInfo } from '../app-updates/plugin.js';
import type { Checks, GitEnv } from './git-ops.js';
import { closeWorktree, commitAll, git, headOf, openWorktree, tail } from './git-ops.js';

const BUILD_TIMEOUT_MS = 40 * 60_000;
/** This checkout's CLI, for builds that go through it (`phone apk`). */
const AX_BIN = fileURLToPath(new URL('../../../bin/ax-kit.mjs', import.meta.url));

/** One of the assistant's own apps, kept next to ax-kit on this Mac so the "ax 개선" room can change it too. */
export interface AppRepo {
  name: 'desktop' | 'ios' | 'android';
  label: string;
  path: string;
  stack: string;
  /** Run in the app's worktree before it is merged; empty = cannot be checked here (it stays on its branch). */
  checks: Checks;
  /** Why it cannot be checked here, in plain words, when `checks` is empty. */
  missing?: string;
  env: Record<string, string>;
  /** After merging: the build that makes the installable app, its output and where this Mac keeps it to hand out. */
  build?: { cmd: readonly string[]; artifact: string; publish: string };
  /** How the owner gets the new version on their device, in plain words. */
  install: string;
}

const exists = async (path: string): Promise<boolean> => await access(path).then(() => true, () => false);

/** The app repos in ~/ax-kit-apps (ax-kit-desktop, -ios, -android) with what this Mac can check and build. */
export async function detectApps(run: ProcessRunner, home = homedir(), axHome = join(home, '.ax-kit')): Promise<AppRepo[]> {
  const root = join(home, 'ax-kit-apps');
  const path = `${join(home, '.cargo', 'bin')}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
  const apps: AppRepo[] = [];
  const desktop = join(root, 'ax-kit-desktop');
  if (await exists(join(desktop, '.git'))) {
    const cargo = await exists(join(home, '.cargo', 'bin', 'cargo'));
    apps.push({
      name: 'desktop',
      label: '맥 데스크톱 앱',
      path: desktop,
      stack: 'Tauri 2 (Rust) + React/TypeScript (Vite)',
      checks: [['npm', 'run', 'typecheck'], ['npm', 'test']],
      env: { PATH: path },
      ...(cargo ? { build: { cmd: ['npm', 'run', 'package-zip'], artifact: join(desktop, 'release', 'ax-kit-desktop.zip'), publish: join(axHome, 'dist', 'ax-kit-desktop.zip') } } : {}),
      install: cargo ? '연결된 맥 앱이 새 버전을 알아서 알려 줘요 (앱에서 "새 버전으로 바꾸기"). 처음 까는 맥은 이 맥에서 `ax-kit phone install-mac`.' : '이 맥에 Rust가 없어서 앱을 새로 만들지는 못했어요.',
    });
  }
  const android = join(root, 'ax-kit-android');
  if (await exists(join(android, '.git'))) {
    const java = findJavaHome() ?? '/opt/homebrew/opt/openjdk@17';
    const sdk = findAndroidSdk() ?? '/opt/homebrew/share/android-commandlinetools';
    const ready = (await exists(join(java, 'bin', 'java'))) && (await exists(join(sdk, 'platforms')));
    apps.push({
      name: 'android',
      label: '안드로이드 앱',
      path: android,
      stack: 'Kotlin, Jetpack Compose, Gradle',
      checks: ready ? [['./gradlew', '--no-daemon', '-q', 'testDebugUnitTest']] : [],
      ...(ready ? {} : { missing: '이 맥에 Java 17이나 Android SDK가 없어요' }),
      env: { PATH: `${join(java, 'bin')}:${path}`, JAVA_HOME: java, ANDROID_HOME: sdk },
      // the signed release build `phone apk` makes (one key on this Mac, a growing version), so phones update over it
      ...(ready ? { build: { cmd: [process.execPath, AX_BIN, 'phone', 'apk', '--build'], artifact: updatePaths(axHome).apk, publish: updatePaths(axHome).apk } } : {}),
      install: '휴대폰 앱이 새 버전을 알아서 알려 줘요 (앱에서 "새 버전으로 바꾸기"). 처음 까는 휴대폰은 이 맥에서 `ax-kit phone apk`로 QR을 찍어요.',
    });
  }
  const ios = join(root, 'ax-kit-ios');
  if (await exists(join(ios, '.git'))) {
    const selected = await run('xcode-select', ['-p'], { timeoutMs: 10_000 }).catch(() => undefined);
    const xcode = selected?.code === 0 && selected.stdout.includes('Xcode.app');
    apps.push({
      name: 'ios',
      label: '아이폰 앱',
      path: ios,
      stack: 'SwiftUI (Xcode project AxKit.xcodeproj, Swift packages in Packages/)',
      checks: xcode ? [['swift', 'test', '--package-path', 'Packages/AxKitCore']] : [],
      ...(xcode ? {} : { missing: '이 맥에 Xcode가 없어요 (App Store에서 Xcode를 설치하면 검사하고 빌드할 수 있어요)' }),
      env: { PATH: path },
      install: '아이폰에 새 버전은 TestFlight로 올려야 해요. Xcode가 있는 맥에서 올린 뒤 TestFlight 앱에서 업데이트해 주세요.',
    });
  }
  return apps;
}

/** The app worktrees of one job, beside the ax-kit one: `${workDir}/${id}-apps/<name>`. */
export async function openAppWorktrees(run: ProcessRunner, apps: readonly AppRepo[], workDir: string, id: string): Promise<{ app: AppRepo; dir: string; base: string }[]> {
  const opened: { app: AppRepo; dir: string; base: string }[] = [];
  for (const app of apps) {
    const env: GitEnv = { root: app.path, run };
    const base = await headOf(env);
    const dir = join(workDir, `${id}-apps`, app.name);
    if (base === undefined) continue;
    await mkdir(dirname(dir), { recursive: true });
    if ((await openWorktree(env, dir, `ax-self/${id}`, base)).ok) opened.push({ app, dir, base });
  }
  return opened;
}

/** Instructions for the lead coder: which app folders it may change and when. */
export function appsPrompt(opened: readonly { app: AppRepo; dir: string }[]): string {
  if (opened.length === 0) return '';
  return [
    "The assistant's own apps are also here, each a git worktree you may edit when the request is about that app (or a server change needs the app to follow):",
    ...opened.map(({ app, dir }) => `- ${app.label} (${app.name}): ${dir} — ${app.stack}${app.checks.length === 0 ? ' (cannot be checked on this Mac: keep changes small)' : ''}`),
    'Leave an app folder untouched when the request is not about it. The app protocol lives in docs/APP-PROTOCOL.md of ax-kit: keep server and apps in step.',
  ].join('\n');
}

export interface AppResult {
  app: AppRepo;
  status: 'applied' | 'kept' | 'failed';
  detail: string;
  commit?: string;
  built?: string;
}

/**
 * After the coder: each app it changed is checked (with fix rounds by `fix`), committed, fast-forwarded into the app
 * repo and built when this Mac can; one it cannot check stays on its branch for a person to look at.
 */
export async function applyApps(
  run: ProcessRunner,
  opened: readonly { app: AppRepo; dir: string; base: string }[],
  id: string,
  message: string,
  fix: (app: AppRepo, dir: string) => Promise<{ ok: boolean; detail: string }>,
  say: (line: string) => void,
): Promise<AppResult[]> {
  const results: AppResult[] = [];
  for (const { app, dir, base } of opened) {
    const env: GitEnv = { root: app.path, run };
    const changed = await git(env, ['status', '--porcelain', '--', '.', ':(exclude)node_modules'], dir);
    if (changed.out === '') {
      await closeWorktree(env, dir, `ax-self/${id}`);
      continue;
    }
    if (app.checks.length === 0) {
      const kept = await commitAll(env, dir, `${message} (${app.name})`);
      results.push({ app, status: 'kept', detail: typeof kept === 'object' ? kept.error : `${app.missing ?? '검사할 수 없어요'}. 브랜치 ax-self/${id}에 남겨 뒀어요.` });
      await git(env, ['worktree', 'remove', '--force', dir]);
      continue;
    }
    say(`${app.label}을(를) 검사하는 중이에요…`);
    const checked = await fix(app, dir);
    if (!checked.ok) {
      await commitAll(env, dir, `${message} (${app.name}, 검사 실패)`);
      await git(env, ['worktree', 'remove', '--force', dir]);
      results.push({ app, status: 'failed', detail: `검사에서 걸려서 합치지 않았어요 (브랜치 ax-self/${id}).\n${tail(checked.detail).slice(-800)}` });
      continue;
    }
    const committed = await commitAll(env, dir, `${message} (${app.name})`);
    const dirty = await git(env, ['status', '--porcelain', '--untracked-files=no']);
    if (typeof committed === 'object' || dirty.out !== '' || (await headOf(env)) !== base) {
      await git(env, ['worktree', 'remove', '--force', dir]);
      results.push({ app, status: 'kept', detail: `앱 저장소가 그사이 바뀌었거나 정리되지 않은 변경이 있어서 브랜치 ax-self/${id}에 남겨 뒀어요.` });
      continue;
    }
    const merged = await git(env, ['merge', '--ff-only', '-q', `ax-self/${id}`]);
    await closeWorktree(env, dir, `ax-self/${id}`, !merged.ok);
    if (!merged.ok) {
      results.push({ app, status: 'failed', detail: merged.out });
      continue;
    }
    const commit = (await git(env, ['rev-parse', '--short', 'HEAD'])).out;
    let built: string | undefined;
    if (app.build !== undefined) {
      say(`${app.label}을(를) 새로 만드는 중이에요…`);
      const [cmd, ...args] = app.build.cmd;
      const result = cmd === undefined ? undefined : await run(cmd, args, { cwd: app.path, env: app.env, timeoutMs: BUILD_TIMEOUT_MS }).catch(() => undefined);
      if (result?.code === 0 && (await exists(app.build.artifact))) {
        await mkdir(dirname(app.build.publish), { recursive: true });
        if (app.build.artifact !== app.build.publish) await copyFile(app.build.artifact, app.build.publish);
        // the Mac app's build number for the update check (Android's comes from `phone apk`)
        if (app.name === 'desktop') {
          const counted = await run('git', ['-C', app.path, 'rev-list', '--count', 'HEAD'], { timeoutMs: 10_000 }).catch(() => undefined);
          const build = Math.max(1, Number.parseInt(counted?.stdout.trim() ?? '', 10) || 1);
          await writeBuildInfo(app.build.publish, app.build.publish.replace(/\.zip$/, '.json'), build, `0.1.${build}`).catch(() => undefined);
        }
        built = app.build.publish;
      }
    }
    results.push({ app, status: 'applied', commit, detail: built !== undefined ? app.install : app.build !== undefined ? '합쳤지만 새로 만들지는 못했어요(빌드 실패).' : app.install, ...(built !== undefined ? { built } : {}) });
  }
  return results;
}

export function appsReport(results: readonly AppResult[]): string {
  return results
    .map((result) => `· ${result.app.label}: ${result.status === 'applied' ? `적용했어요 (${result.commit ?? ''})${result.built !== undefined ? ', 새로 만들었어요' : ''}. ${result.detail}` : result.detail}`)
    .join('\n');
}
