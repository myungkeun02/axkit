import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProjectCandidate } from '../skills/onboarding/projects.js';
import { discoverOnThisComputer } from '../app/discover-projects.js';
import { remoteAll } from '../core/remote/ids.js';
import { DEFAULT_SOURCE_PORT } from '../core/remote/protocol.js';
import { readRemotes, remotesFile } from '../connectors/remote-sources/store.js';
import type { PairedRemote } from '../connectors/remote-sources/store.js';
import { remoteSourcesFrom } from '../app/remote-sources.js';
import type { Prompter } from './prompter.js';
import type { RemoteDeps } from './remote.js';
import { addRemote, checkRemote, failureText } from './remote.js';

/** Where the owner's work files are, as the first-look step needs it. */
export interface WorkPlace {
  /** Ask for this Mac's folders too. */
  local: boolean;
  /** "remote:MacBook" for each paired Mac to read (all the folders shared there). */
  folders: string[];
}

export type WorkPlaceStep = (prompter: Prompter) => Promise<WorkPlace>;

export const INSTALL_ONE_LINER = 'git clone https://github.com/myungkeun02/axkit.git ~/ax-kit && AX_KIT_NO_SETUP=1 bash ~/ax-kit/install.sh';

const STEPS = [
  '다른 맥(작업용 맥북 등)의 파일을 읽으려면:',
  '  0) 두 맥 모두 Tailscale 앱에 같은 계정으로 로그인 (https://tailscale.com/download)',
  '  1) 설정이 끝난 뒤 이 맥에서 `ax-kit remote install` → 그 맥 터미널에 붙여 넣을 한 줄이 나와요',
  '  2) 그 맥에서 한 줄을 붙여 넣으면 ax-kit을 받고, 보여 줄 폴더를 고른 뒤, 연결까지 알아서 해요',
  '그 맥에서는 고른 폴더 안의 파일을 읽기만 해요. 아무것도 바꾸거나 지우지 않아요.',
  '(이미 그 맥에 ax-kit이 있으면: 그 맥에서 `ax-kit source pair` → 여기서 주소와 코드를 입력)',
];

async function connectOne(deps: RemoteDeps): Promise<PairedRemote | undefined> {
  for (;;) {
    const remote = await addRemote(deps);
    if (remote !== undefined) return remote;
    const again = await deps.prompter.choose(
      '어떻게 할까요?',
      [
        { value: 'retry', label: '다시 시도 (주소·코드 다시 입력)' },
        { value: 'skip', label: '다른 맥은 건너뛰기 (나중에 `ax-kit remote add`)' },
      ],
      0,
    );
    if (again === 'skip') return undefined;
  }
}

/** Already-paired Macs that answer now; the rest are named and left out of this look. */
async function reachable(deps: RemoteDeps, remotes: readonly PairedRemote[]): Promise<PairedRemote[]> {
  const ok: PairedRemote[] = [];
  for (const [index, source] of remoteSourcesFrom(remotes, deps.secrets, deps.post).entries()) {
    const remote = remotes[index];
    if (remote === undefined) continue;
    try {
      const check = await checkRemote(source);
      deps.prompter.say(`${remote.name}: 공유 폴더 ${check.folders.length}개 · 대화 ${check.sessions}개`);
      ok.push(remote);
    } catch (error) {
      deps.prompter.say(`${remote.name}: ${failureText(error)}`);
    }
  }
  return ok;
}

async function remoteFolders(deps: RemoteDeps): Promise<string[]> {
  const { prompter } = deps;
  const paired = await readRemotes(deps.file);
  let chosen: PairedRemote[] = [];
  if (paired.length > 0) {
    prompter.say(`이미 연결된 맥: ${paired.map((remote) => remote.name).join(', ')}`);
    chosen = await reachable(deps, paired);
    const more = await prompter.choose(
      '다른 맥을 더 연결할까요?',
      [
        { value: 'no', label: '아니요, 연결된 맥으로 충분해요' },
        { value: 'yes', label: '네, 한 대 더 연결' },
      ],
      0,
    );
    if (more === 'no') return chosen.map((remote) => remoteAll(remote.name));
  }
  prompter.say('');
  for (const line of STEPS) prompter.say(line);
  prompter.say(`(기본 포트는 ${DEFAULT_SOURCE_PORT}이에요.)`);
  await prompter.text('준비되면 엔터', { default: '' });
  const added = await connectOne(deps);
  if (added !== undefined) chosen.push(added);
  if (chosen.length > 0) prompter.say(`프로젝트 목록에서 "${chosen[0]?.name ?? 'MacBook'}:~/…"처럼 이름이 붙은 건 그 맥에 있어요.`);
  return chosen.map((remote) => remoteAll(remote.name));
}

/**
 * The first-look question "where are your work files": this Mac, another Mac (a work MacBook on Tailscale), or both.
 * For another Mac it walks through installing and pairing there, tests the connection and says what it found.
 */
export function workPlaceStep(deps: Omit<RemoteDeps, 'prompter'>): WorkPlaceStep {
  return async (prompter) => {
    const where = await prompter.choose(
      '일하는 파일은 어디에 있나요?',
      [
        { value: 'here', label: '이 맥' },
        { value: 'remote', label: '다른 맥 (작업용 맥북 등)' },
        { value: 'both', label: '둘 다' },
      ],
      (await readRemotes(deps.file)).length > 0 ? 2 : 0,
    );
    if (where === 'here') return { local: true, folders: [] };
    const folders = await remoteFolders({ ...deps, prompter });
    if (folders.length === 0 && where === 'remote') prompter.say('다른 맥을 연결하지 못해서 이 맥의 폴더만 볼게요.');
    return { local: where === 'both' || folders.length === 0, folders };
  };
}

/** For `ax-kit setup`: the where-question, and project discovery that includes the paired Macs. */
export function nodeRemoteOnboarding(axHome: string, secrets: RemoteDeps['secrets']): {
  workPlace: WorkPlaceStep;
  discover: (folders: readonly string[]) => Promise<ProjectCandidate[]>;
} {
  const file = remotesFile(axHome);
  return {
    workPlace: workPlaceStep({ secrets, file, now: () => new Date() }),
    discover: async (folders) => {
      const home = homedir();
      const expanded = folders.map((folder) => (folder === '~' ? home : folder.startsWith('~/') ? join(home, folder.slice(2)) : folder));
      return await discoverOnThisComputer(expanded, { remotes: remoteSourcesFrom(await readRemotes(file), secrets) });
    },
  };
}
