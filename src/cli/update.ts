import { spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { CODE_DIR } from '../app/core-services.js';
import { LAUNCHD_LABEL } from './service.js';

/** Runs with the terminal attached; resolves to the exit code. */
export function runAttached(cmd: string, args: readonly string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: 'inherit', ...(cwd !== undefined ? { cwd } : {}) });
    child.on('error', () => resolve(127));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * `ax-kit update`: the newest code from GitHub (fast-forward only, never over local changes), dependencies, then a
 * restart of the background service if it is installed.
 */
export async function updateCommand(say: (line: string) => void, run = runAttached): Promise<number> {
  say(`ax-kit 위치: ${CODE_DIR}`);
  if ((await run('git', ['-C', CODE_DIR, 'pull', '--ff-only'])) !== 0) {
    say('새 코드를 받지 못했어요. 이 맥에서 고친 코드가 있거나 인터넷이 끊겼을 수 있어요 (`git status`로 확인).');
    return 1;
  }
  if ((await run('pnpm', ['install', '--frozen-lockfile'], CODE_DIR)) !== 0) {
    say('패키지를 설치하지 못했어요. `pnpm install`을 직접 실행해 주세요.');
    return 1;
  }
  const target = `gui/${userInfo().uid}/${LAUNCHD_LABEL}`;
  if ((await run('launchctl', ['print', target])) === 0) {
    await run('launchctl', ['kickstart', '-k', target]);
    say('백그라운드 서비스를 다시 시작했어요.');
  }
  say('업데이트 끝. `ax-kit features`로 켜진 기능을 볼 수 있어요.');
  return 0;
}
