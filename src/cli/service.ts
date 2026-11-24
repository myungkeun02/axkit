import { join } from 'node:path';
import { commonBinDirs } from '../core/process/resolve-command.js';
import { renderLaunchAgent } from './launchd.js';

export const LAUNCHD_LABEL = 'io.axkit.assistant';

export interface ServiceDeps {
  home: string;
  launchAgentsDir: string;
  uid: number;
  nodePath: string;
  entry: string;
  exec(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }>;
  writeFile(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  say(line: string): void;
}

export interface LogPaths {
  dir: string;
  out: string;
  err: string;
}

/** Where launchd writes the daemon's stdout and stderr. */
export function logPaths(home: string): LogPaths {
  const dir = join(home, 'logs');
  return { dir, out: join(dir, 'ax-kit.out.log'), err: join(dir, 'ax-kit.err.log') };
}

function plistPath(deps: ServiceDeps): string {
  return join(deps.launchAgentsDir, `${LAUNCHD_LABEL}.plist`);
}

function target(deps: ServiceDeps): string {
  return `gui/${deps.uid}/${LAUNCHD_LABEL}`;
}

function failureDetail(result: { code: number; stderr: string }): string {
  const text = result.stderr.trim();
  return text.length > 0 ? text : `exit ${result.code}`;
}

function macMiniTips(deps: ServiceDeps): void {
  deps.say('맥미니 팁:');
  deps.say('- 잠자기 끄기: 시스템 설정 > 에너지');
  deps.say('- 정전 후 자동으로 켜지게 하려면 시스템 설정 > 에너지의 해당 옵션을 켜 주세요');
  deps.say(
    '- 자동 로그인을 켜면 Keychain이 잠기지 않아요. 다만 FileVault와는 함께 쓸 수 없으니 보안과 편의 중에 선택해 주세요',
  );
}

/** Writes the LaunchAgent plist and (re)loads it with launchctl. */
export async function serviceInstall(deps: ServiceDeps): Promise<number> {
  const logs = logPaths(deps.home);
  const plist = plistPath(deps);

  await deps.mkdir(logs.dir);
  await deps.mkdir(deps.launchAgentsDir);
  await deps.writeFile(
    plist,
    renderLaunchAgent({
      label: LAUNCHD_LABEL,
      nodePath: deps.nodePath,
      entry: deps.entry,
      home: deps.home,
      logDir: logs.dir,
      extraPath: [...(process.env['PATH'] ?? '').split(':'), ...commonBinDirs()],
    }),
  );

  // A stale or running copy rejects bootstrap; unloading it first is best effort.
  await deps.exec('launchctl', ['bootout', target(deps)]);
  const bootstrap = await deps.exec('launchctl', ['bootstrap', `gui/${deps.uid}`, plist]);
  if (bootstrap.code !== 0) {
    deps.say(`설치하지 못했어요: ${failureDetail(bootstrap)}`);
    return 1;
  }

  const kickstart = await deps.exec('launchctl', ['kickstart', '-k', target(deps)]);
  if (kickstart.code !== 0) {
    deps.say(`설치는 됐지만 시작하지 못했어요: ${failureDetail(kickstart)}`);
    return 1;
  }

  deps.say('설치했어요. 이제 로그인할 때마다 자동으로 시작해요.');
  deps.say(`로그: ${logs.out} / ${logs.err}`);
  macMiniTips(deps);
  return 0;
}

/** Unloads the agent and removes its plist. Safe when it was never installed. */
export async function serviceUninstall(deps: ServiceDeps): Promise<number> {
  await deps.exec('launchctl', ['bootout', target(deps)]);
  await deps.removeFile(plistPath(deps));
  deps.say('제거했어요. 자동 시작을 멈췄어요.');
  return 0;
}

/** Prints whether launchd has the agent loaded and, if so, its state and pid. */
export async function serviceStatus(deps: ServiceDeps): Promise<number> {
  const result = await deps.exec('launchctl', ['print', target(deps)]);
  if (result.code !== 0) {
    deps.say('설치되어 있지 않거나 실행 중이 아니에요. `ax-kit service install`로 설치할 수 있어요.');
    return 1;
  }

  const state = /^\s*state = (.+)$/m.exec(result.stdout)?.[1]?.trim();
  const pid = /^\s*pid = (\d+)$/m.exec(result.stdout)?.[1];
  deps.say(`상태: ${state ?? '알 수 없음'}`);
  if (pid !== undefined) deps.say(`PID: ${pid}`);

  const logs = logPaths(deps.home);
  deps.say(`로그: ${logs.out} / ${logs.err}`);
  return 0;
}
