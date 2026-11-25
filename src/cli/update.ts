import { execFile, spawn } from 'node:child_process';
import { userInfo } from 'node:os';
import { CODE_DIR } from '../app/core-services.js';
import type { ExecResult } from './tailscale.js';
import { LAUNCHD_LABEL } from './service.js';

/** Runs with the terminal attached; resolves to the exit code. */
export function runAttached(cmd: string, args: readonly string[], cwd?: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...args], { stdio: 'inherit', ...(cwd !== undefined ? { cwd } : {}) });
    child.on('error', () => resolve(127));
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/** Runs quietly and keeps the output. */
function execQuiet(cmd: string, args: readonly string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

type Run = (cmd: string, args: readonly string[], cwd?: string) => Promise<number>;
type Exec = (cmd: string, args: readonly string[]) => Promise<ExecResult>;

/** The branch kept at the code from before the last update, to go back by hand. */
export const BEFORE_UPDATE_BRANCH = 'ax-kit-before-update';
/** Commits this Mac makes for its own edits are by this name, never pushed anywhere. */
const LOCAL_ID = ['-c', 'user.name=ax-kit (이 맥)', '-c', 'user.email=ax-kit@localhost'];

function stamp(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

interface UpdateDeps {
  run?: Run;
  exec?: Exec;
  now?: () => Date;
  dir?: string;
}

/**
 * `ax-kit update`: the newest code from GitHub with this Mac's own edits kept on top. Edits not yet committed are
 * committed first (locally, by "ax-kit (이 맥)"); the Mac's commits are then replayed over the new code. A conflict, a
 * failed install or new code that does not start puts everything back as it was, so the running assistant never ends
 * up on broken code. Then the background service restarts if it is installed.
 */
export async function updateCommand(say: (line: string) => void, run: Run = runAttached, deps: UpdateDeps = {}): Promise<number> {
  const exec = deps.exec ?? execQuiet;
  const dir = deps.dir ?? CODE_DIR;
  const now = deps.now ?? (() => new Date());
  const git = (...args: string[]): Promise<ExecResult> => exec('git', ['-C', dir, ...args]);
  say(`ax-kit 위치: ${dir}`);

  if ((await git('rev-parse', '--abbrev-ref', '@{u}')).code !== 0) {
    say('이 폴더는 GitHub 코드와 이어져 있지 않아서 업데이트할 수 없어요 (`git status`로 확인).');
    return 1;
  }
  // a half-finished replay from an earlier run would block everything after it
  if ((await git('rev-parse', '-q', '--verify', 'REBASE_HEAD')).code === 0) await git('rebase', '--abort');

  const dirty = (await git('status', '--porcelain')).stdout.trim() !== '';
  if (dirty) {
    const added = await git('add', '-A');
    const committed = added.code === 0 ? await git(...LOCAL_ID, 'commit', '-q', '-m', `이 맥에서 고친 내용 (${stamp(now())})`) : added;
    if (committed.code !== 0) {
      say(`이 맥에서 고친 내용을 보관하지 못해서 업데이트를 멈췄어요: ${committed.stderr.trim().split('\n')[0] ?? ''}`);
      return 1;
    }
    say('이 맥에서 고친 내용을 먼저 보관했어요 (업데이트 뒤에 다시 얹어요).');
  }
  const before = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('branch', '-f', BEFORE_UPDATE_BRANCH, before);

  if ((await git('fetch', '-q')).code !== 0) {
    say('새 코드를 받지 못했어요. 인터넷 연결을 확인해 주세요. 지금 코드는 그대로예요.');
    return 1;
  }
  const ownCommits = Number((await git('rev-list', '--count', '@{u}..HEAD')).stdout.trim()) || 0;
  const replayed = await git(...LOCAL_ID, 'rebase', '-q', '@{u}');
  if (replayed.code !== 0) {
    const files = (await git('diff', '--name-only', '--diff-filter=U')).stdout.trim().split('\n').filter((line) => line !== '');
    await git('rebase', '--abort');
    await git('reset', '-q', '--hard', before);
    say('이 맥에서 고친 내용이 새 코드와 같은 곳을 고쳐서 합치지 못했어요. 업데이트 전 그대로 두었어요.');
    if (files.length > 0) say(`겹치는 파일: ${files.slice(0, 10).join(', ')}`);
    say('이 맥에서 고친 부분을 정리하거나, 고친 내용을 레포에 올린 뒤 다시 `ax-kit update` 해 주세요.');
    return 1;
  }

  const rollBack = async (why: string): Promise<number> => {
    await git('reset', '-q', '--hard', before);
    await run('pnpm', ['install', '--frozen-lockfile'], dir);
    say(`${why} 업데이트 전 코드로 되돌렸어요.`);
    return 1;
  };
  if ((await run('pnpm', ['install', '--frozen-lockfile'], dir)) !== 0) return await rollBack('패키지를 설치하지 못해서');
  // the new code (with this Mac's edits on top) must at least start before the service runs it
  if ((await exec(process.execPath, [`${dir}/bin/ax-kit.mjs`, 'help'])).code !== 0) return await rollBack('새 코드가 시작되지 않아서');

  if (ownCommits > 0) say(`이 맥에서 고친 내용(${String(ownCommits)}개)을 새 코드 위에 다시 얹었어요. 전 코드는 \`${BEFORE_UPDATE_BRANCH}\` 브랜치에 있어요.`);
  const target = `gui/${userInfo().uid}/${LAUNCHD_LABEL}`;
  if ((await run('launchctl', ['print', target])) === 0) {
    await run('launchctl', ['kickstart', '-k', target]);
    say('백그라운드 서비스를 다시 시작했어요.');
  }
  say('업데이트 끝. `ax-kit features`로 켜진 기능을 볼 수 있어요.');
  return 0;
}
