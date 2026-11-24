import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PhoneAdminHandle } from '../app/phone.js';
import { installCommand } from '../mobile/install-links.js';
import type { RemoteDeps } from './remote.js';
import { addRemote } from './remote.js';
import type { Exec } from './tailscale.js';

const AX_KIT_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Long enough to install Node and packages on a fresh Mac. */
const LINK_TTL_MS = 30 * 60_000;
const POLL_MS = 3_000;

export interface RemoteInstallDeps {
  remote: RemoteDeps;
  home: string;
  /** This Mac's https address on the tailnet (the phone bridge's), undefined when there is none yet. */
  publicUrl: () => Promise<string | undefined>;
  openAdmin: (home: string) => PhoneAdminHandle;
  exec: Exec;
  sleep?: (ms: number) => Promise<void>;
  /** For tests: the source tarball already made. */
  tarball?: string;
}

/** This checkout as a tarball (`git archive`: the code without node_modules or local files) to hand to another Mac. */
async function makeTarball(deps: RemoteInstallDeps): Promise<string | undefined> {
  if (deps.tarball !== undefined) return deps.tarball;
  const out = join(deps.home, 'dist', 'ax-kit-source.tar.gz');
  await mkdir(join(deps.home, 'dist'), { recursive: true });
  const made = await deps.exec('git', ['-C', AX_KIT_ROOT, 'archive', '--format=tar.gz', '-o', out, 'HEAD']).catch(() => undefined);
  return made?.code === 0 ? out : undefined;
}

/**
 * `ax-kit remote install`: lets the assistant read files on another Mac without anyone cloning a repository there.
 * One line pasted in that Mac's terminal downloads ax-kit from this Mac, installs it, asks which folders to share,
 * and reports its code back; this command waits for that and finishes the pairing.
 */
export async function remoteInstall(deps: RemoteInstallDeps): Promise<number> {
  const { prompter } = deps.remote;
  const base = await deps.publicUrl();
  if (base === undefined) {
    prompter.say('다른 맥이 이 맥에 닿을 주소가 아직 없어요. 먼저 `ax-kit phone funnel --fix`로 준비해 주세요 (Tailscale 안에서만 열려요).');
    return 1;
  }
  const tarball = await makeTarball(deps);
  if (tarball === undefined) {
    prompter.say('나눠 줄 ax-kit을 만들지 못했어요. 이 맥의 ax-kit 폴더가 git 저장소인지 확인해 주세요.');
    return 1;
  }
  let handle = deps.openAdmin(deps.home);
  const link = await handle.install.create({ zip: tarball, base, pair: '', kind: 'source', ttlMs: LINK_TTL_MS }).finally(() => handle.close());
  prompter.say('파일을 읽을 맥(업무용 맥북 등)에서 터미널(응용 프로그램 › 유틸리티 › 터미널)을 열고, 아래 한 줄을 붙여 넣어 엔터를 눌러 주세요.');
  prompter.say('그 맥에 ax-kit을 받고, 보여 줄 폴더를 고르게 한 뒤, 연결까지 알아서 해요 (30분 안에, 한 번만). 두 맥 모두 Tailscale에 같은 계정으로 로그인돼 있어야 해요.');
  prompter.say(`  ${installCommand(link)}`);
  prompter.say('그 맥에서 끝나기를 기다리는 중이에요… (Ctrl+C로 그만두면 나중에 `ax-kit remote add`로 연결할 수 있어요)');
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = Date.parse(link.expiresAt);
  for (;;) {
    if (deps.remote.now().getTime() > until) {
      prompter.say('30분 안에 연결되지 않았어요. 다시 하려면 `ax-kit remote install`을 실행해 주세요.');
      return 1;
    }
    handle = deps.openAdmin(deps.home);
    const reported = await handle.install.find(link.nonce).then((found) => found?.reported).finally(() => handle.close());
    if (reported !== undefined) {
      prompter.say('그 맥이 준비됐어요. 연결을 마무리할게요.');
      return (await addRemote(deps.remote, reported)) === undefined ? 1 : 0;
    }
    await sleep(POLL_MS);
  }
}
