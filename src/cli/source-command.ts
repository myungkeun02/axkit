import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeychainSecretStore, createLogger } from '../core/index.js';
import { defaultSourceHome, readSourceConfig } from '../app/source/config.js';
import { startSourceServer } from '../app/source/start.js';
import { SourceTokens } from '../app/source/tokens.js';
import { remotesFile } from '../connectors/remote-sources/store.js';
import { renderLaunchAgent } from './launchd.js';
import { execFileResult } from './phone-deps.js';
import { createTtyPrompter } from './prompter.js';
import { runAttached } from './update.js';
import { addRemote, listRemotes, removeRemote } from './remote.js';
import { remoteInstall } from './remote-install.js';
import { openPhoneAdmin } from '../app/phone.js';
import { phoneDeps } from './phone-deps.js';
import { tailscaleStatus } from './tailscale.js';
import { runSourcePair, runSourceSetup, tailscaleIp } from './source.js';

export const SOURCE_LAUNCHD_LABEL = 'io.axkit.source';
const RETRY_MS = 60_000;

const say = (line: string): void => {
  console.log(line);
};

async function dirExists(path: string): Promise<boolean> {
  return await stat(path).then((info) => info.isDirectory(), () => false);
}

/** Runs until stopped. Listens on 127.0.0.1 and, once Tailscale is up, on its address too. */
async function serve(sourceHome: string): Promise<number> {
  const config = await readSourceConfig(sourceHome);
  if (config === undefined) {
    say('먼저 `ax-kit source setup`으로 보여 줄 폴더를 골라 주세요.');
    return 1;
  }
  const log = createLogger();
  let ip = await tailscaleIp(execFileResult);
  const running = await startSourceServer({ config, sourceHome, hosts: ['127.0.0.1', ...(ip !== undefined ? [ip] : [])], log });
  say(`열었어요: 127.0.0.1:${config.port}${ip !== undefined ? `, ${ip}:${config.port}` : ' (Tailscale이 켜지면 그 주소도 열어요)'} · 폴더 ${config.folders.length}개 · 읽기 전용`);
  const timer = setInterval(() => {
    if (ip !== undefined) return;
    void tailscaleIp(execFileResult).then(async (found) => {
      if (found === undefined || ip !== undefined) return;
      ip = found;
      await running.listen(found).catch(() => {
        ip = undefined;
      });
      if (ip !== undefined) log.info('source: listening on the Tailscale address');
    });
  }, RETRY_MS);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  clearInterval(timer);
  await running.close();
  return 0;
}

function plistPath(): string {
  return join(userInfo().homedir, 'Library', 'LaunchAgents', `${SOURCE_LAUNCHD_LABEL}.plist`);
}

async function install(sourceHome: string): Promise<number> {
  const logDir = join(sourceHome, 'logs');
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  await mkdir(join(userInfo().homedir, 'Library', 'LaunchAgents'), { recursive: true });
  const plist = renderLaunchAgent({
    label: SOURCE_LAUNCHD_LABEL,
    nodePath: process.execPath,
    entry: fileURLToPath(new URL('../../bin/ax-kit.mjs', import.meta.url)),
    home: sourceHome,
    logDir,
    args: ['source', 'serve'],
    logName: 'source',
  });
  await writeFile(plistPath(), plist, { mode: 0o600 });
  const target = `gui/${userInfo().uid}/${SOURCE_LAUNCHD_LABEL}`;
  await execFileResult('launchctl', ['bootout', target]);
  const boot = await execFileResult('launchctl', ['bootstrap', `gui/${userInfo().uid}`, plistPath()]);
  if (boot.code !== 0) {
    say(`등록하지 못했어요: ${boot.stderr.trim() || `exit ${boot.code}`}`);
    return 1;
  }
  await execFileResult('launchctl', ['kickstart', '-k', target]);
  say('등록했어요. 이제 로그인할 때마다 자동으로 켜져요. 끄려면: ax-kit source uninstall');
  say(`로그: ${join(logDir, 'source.out.log')}`);
  return 0;
}

async function uninstall(): Promise<number> {
  await execFileResult('launchctl', ['bootout', `gui/${userInfo().uid}/${SOURCE_LAUNCHD_LABEL}`]);
  await rm(plistPath(), { force: true });
  say('껐어요. 이제 다른 맥에서 이 맥의 파일을 읽을 수 없어요.');
  return 0;
}

async function status(sourceHome: string): Promise<number> {
  const config = await readSourceConfig(sourceHome);
  const loaded = (await execFileResult('launchctl', ['print', `gui/${userInfo().uid}/${SOURCE_LAUNCHD_LABEL}`])).code === 0;
  say(`자동 시작: ${loaded ? '켜짐' : '꺼짐'}`);
  say(config === undefined ? '설정 없음 (`ax-kit source setup`)' : `보여 주는 폴더: ${config.folders.join(', ') || '없음'} · 대화 기록: ${config.sessions ? '보여 줌' : '안 보여 줌'}`);
  const clients = await new SourceTokens({ dir: sourceHome }).clients();
  say(clients.length === 0 ? '짝지은 맥: 없음' : `짝지은 맥: ${clients.map((client) => `${client.name} (${client.id})`).join(', ')}`);
  return 0;
}

const SOURCE_HELP = 'ax-kit source setup | serve | pair | install | uninstall | status | revoke <이름|id|all>';

/** `ax-kit source …`, run on the Mac whose files are shared (a work MacBook). */
export async function sourceCommand(positionals: readonly string[]): Promise<number> {
  const sourceHome = defaultSourceHome();
  switch (positionals[1]) {
    case 'setup': {
      await runSourceSetup({ prompter: createTtyPrompter(), sourceHome, home: homedir(), dirExists, defaults: process.env.AX_KIT_SOURCE_DEFAULTS === '1' });
      say('다음: ax-kit source install (자동 시작) → ax-kit source pair (연결 코드)');
      return 0;
    }
    case 'serve':
      return await serve(sourceHome);
    case 'pair': {
      // `source pair <install link>/paired`: handed the code to the assistant's Mac that sent the install
      const target = positionals[2];
      const report = target !== undefined && /^https:\/\/[^\s]+\/m\/install\/[A-Za-z0-9_-]+\/paired$/.test(target)
        ? async (url: string, code: string): Promise<boolean> => (await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url, code }), signal: AbortSignal.timeout(15_000) })).ok
        : undefined;
      return await runSourcePair({ sourceHome, exec: execFileResult, say, ...(report !== undefined ? { report } : {}) });
    }
    case 'install':
      return await install(sourceHome);
    case 'uninstall':
      return await uninstall();
    case 'status':
      return await status(sourceHome);
    case 'revoke': {
      const which = positionals[2];
      if (which === undefined) break;
      const removed = await new SourceTokens({ dir: sourceHome }).revoke(which);
      say(removed > 0 ? `연결을 끊었어요: ${removed}대` : '그런 이름의 맥이 없어요. `ax-kit source status`로 확인해 주세요.');
      return removed > 0 ? 0 : 1;
    }
    default:
      break;
  }
  say(SOURCE_HELP);
  return 2;
}

/** `ax-kit remote add | list | remove <name>`, run on the assistant's Mac. */
export async function remoteCommand(positionals: readonly string[], home: string, ssh?: string): Promise<number> {
  const deps = { prompter: createTtyPrompter(), secrets: new KeychainSecretStore(), file: remotesFile(home), now: () => new Date(), thisMac: hostname() };
  switch (positionals[1]) {
    case 'add':
      return (await addRemote(deps)) === undefined ? 1 : 0;
    case 'install':
      return await remoteInstall({
        remote: deps,
        home,
        openAdmin: openPhoneAdmin,
        exec: execFileResult,
        ...(ssh !== undefined && ssh.trim() !== ''
          ? { ssh: { target: ssh.trim(), run: async (target: string, command: string) => await runAttached('/usr/bin/ssh', ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', target, command]) } }
          : {}),
        publicUrl: async () => {
          const config = await phoneDeps(home).loadConfig().catch(() => undefined);
          const configured = config?.plugins['bridge.mobile']?.['publicUrl'];
          if (typeof configured === 'string' && configured.trim() !== '') return configured.trim().replace(/\/+$/, '');
          const status = await tailscaleStatus(execFileResult);
          return status.dnsName !== undefined ? `https://${status.dnsName}` : undefined;
        },
      });
    case 'list':
      return await listRemotes(deps);
    case 'remove': {
      const name = positionals[2];
      if (name !== undefined) return await removeRemote(deps, name);
      break;
    }
    default:
      break;
  }
  say('ax-kit remote install (다른 맥에 설치·연결) | add | list | remove <이름>');
  return 2;
}
