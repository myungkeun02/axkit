import { join } from 'node:path';
import type { Prompter } from './prompter.js';

/** Where ax-kit's own apps come from; a fork sets AX_KIT_APPS_BASE (e.g. "https://github.com/me"). */
export const APPS_BASE = 'https://github.com/myungkeun02';
export const APP_REPOS = ['ax-kit-desktop', 'ax-kit-ios', 'ax-kit-android'] as const;

const XCODE_STORE = 'macappstore://apps.apple.com/app/id497799835';

export interface AppDevStepDeps {
  prompter: Prompter;
  /** The owner's home folder (the repos go to ~/ax-kit-apps). */
  userHome: string;
  hasCommand(name: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  /** Runs a program with the terminal attached (progress shows); its exit code. */
  run(cmd: string, args: readonly string[], cwd?: string): Promise<number>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  /** Shows a page or the App Store. */
  openUrl?(url: string): Promise<void>;
  base?: string;
  /** Homebrew's prefix (`brew --prefix`): /opt/homebrew on Apple silicon, /usr/local on Intel. */
  brewPrefix?(): Promise<string>;
}

/** The compileSdk the Android app asks for ("platforms;android-37"), so the SDK matches the code. */
export function androidPackages(gradle: string): string[] {
  const sdk = /compileSdk\s*=\s*(\d+)/.exec(gradle)?.[1] ?? '36';
  return ['platform-tools', `platforms;android-${sdk}`, `build-tools;${sdk}.0.0`];
}

/**
 * "비서가 자기 앱도 고치게": the assistant's own apps next to it and the tools to check and build them on this Mac,
 * so the "ax 개선" room can change the desktop, Android and iPhone apps, build them and hand out the new version.
 * Safe to run again: what is there is skipped. Returns what is ready, in plain words.
 */
export async function setupAppDev(deps: AppDevStepDeps, opts: { ask?: boolean } = {}): Promise<{ ready: string[]; missing: string[] }> {
  const { prompter } = deps;
  const root = join(deps.userHome, 'ax-kit-apps');
  const cargo = join(deps.userHome, '.cargo', 'bin', 'cargo');
  const missing: string[] = [];
  const ready: string[] = [];
  const prefix = (await deps.brewPrefix?.().catch(() => undefined))?.trim() || '/opt/homebrew';
  const JAVA = `${prefix}/opt/openjdk@17`;
  const SDK = `${prefix}/share/android-commandlinetools`;
  if (opts.ask !== false) {
    const answer = await prompter.choose(
      "개발자용: 'ax 개선' 방이 비서의 앱(맥·안드로이드·아이폰)까지 고치고 새로 만들게 이 맥을 준비할까요? (앱 코드와 Rust·Java·Android 도구 약 2GB, Android SDK 이용 약관에 동의하게 돼요)",
      [
        { value: 'later', label: '하지 않기', hint: '앱 코드에 접근할 수 있는 개발자만 필요해요' },
        { value: 'yes', label: '지금 준비' },
      ],
      0,
    );
    if (answer !== 'yes') return { ready, missing: ['앱 고치기 준비를 건너뛰었어요'] };
  }

  // 1) the app code
  for (const name of APP_REPOS) {
    const dir = join(root, name);
    if (await deps.exists(join(dir, '.git'))) continue;
    prompter.say(`${name} 코드를 받는 중이에요…`);
    // never a password prompt in the terminal: no access means "not available", said plainly
    // the public releases are axkit-desktop, axkit-ios, axkit-android; the folders keep the ax-kit-* names
    if ((await deps.run('env', ['GIT_TERMINAL_PROMPT=0', 'git', 'clone', '--quiet', `${deps.base ?? APPS_BASE}/${name.replace(/^ax-kit/, 'axkit')}.git`, dir])) !== 0) missing.push(`${name} 코드를 받지 못했어요 (접근 권한이 있는 GitHub 계정으로 gh auth login 후 다시)`);
  }
  const hasBrew = await deps.hasCommand('brew');

  // 2) the Mac app: Node packages and Rust
  const desktop = join(root, 'ax-kit-desktop');
  if (await deps.exists(join(desktop, '.git'))) {
    if (!(await deps.exists(cargo))) {
      prompter.say('Rust를 설치하는 중이에요 (맥 앱을 만드는 데 필요해요)…');
      await deps.run('bash', ['-c', 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal']);
    }
    if (!(await deps.exists(join(desktop, 'node_modules')))) await deps.run('npm', ['ci', '--no-audit', '--no-fund'], desktop);
    if (await deps.exists(cargo)) ready.push('맥 데스크톱 앱');
    else missing.push('Rust를 설치하지 못했어요 (https://rustup.rs)');
  }

  // 3) the Android app: Java 17, the SDK the app asks for, and where it is
  const android = join(root, 'ax-kit-android');
  if (await deps.exists(join(android, '.git'))) {
    if (!hasBrew) missing.push('Homebrew가 없어서 안드로이드 도구를 못 깔았어요 (https://brew.sh)');
    else {
      if (!(await deps.exists(join(JAVA, 'bin', 'java')))) await deps.run('brew', ['install', 'openjdk@17']);
      if (!(await deps.exists(join(SDK, 'cmdline-tools')))) await deps.run('brew', ['install', '--cask', 'android-commandlinetools']);
      const gradle = await deps.readFile(join(android, 'app', 'build.gradle.kts')).catch(() => '');
      const sdkmanager = `${SDK}/cmdline-tools/latest/bin/sdkmanager`;
      const env = `JAVA_HOME=${JAVA} PATH=${JAVA}/bin:$PATH`;
      const tool = `$(ls ${SDK}/cmdline-tools/*/bin/sdkmanager 2>/dev/null | head -n 1 || echo ${sdkmanager})`;
      prompter.say('Android SDK를 받는 중이에요…');
      await deps.run('bash', ['-c', `export ${env}; yes | ${tool} --sdk_root=${SDK} --licenses >/dev/null; ${tool} --sdk_root=${SDK} ${androidPackages(gradle).map((item) => `"${item}"`).join(' ')}`]);
      await deps.writeFile(join(android, 'local.properties'), `sdk.dir=${SDK}\n`);
      if (await deps.exists(join(SDK, 'platforms'))) ready.push('안드로이드 앱');
      else missing.push('Android SDK를 받지 못했어요');
    }
  }

  // 4) the iPhone app: Xcode comes from the App Store and only a person can install it
  if (await deps.exists(join(root, 'ax-kit-ios', '.git'))) {
    if (await deps.exists('/Applications/Xcode.app')) ready.push('아이폰 앱');
    else {
      missing.push('아이폰 앱은 Xcode가 있어야 검사하고 만들 수 있어요. App Store에서 Xcode를 설치해 주세요 (약 12GB, 한 번만).');
      await deps.openUrl?.(XCODE_STORE).catch(() => undefined);
    }
  }
  prompter.say(ready.length > 0 ? `✓ 'ax 개선' 방이 고칠 수 있는 앱: ${ready.join(', ')}` : '앱을 고칠 준비가 아직 안 됐어요.');
  for (const line of missing) prompter.say(`  · ${line}`);
  return { ready, missing };
}
