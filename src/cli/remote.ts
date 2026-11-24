import { hostname } from 'node:os';
import type { RemoteSource } from '../core/contracts/remote.js';
import type { SecretStore } from '../core/secrets/types.js';
import { isRemoteName, remoteNameFrom, remoteTokenSecret } from '../core/remote/ids.js';
import { DEFAULT_SOURCE_PORT } from '../core/remote/protocol.js';
import type { PostJson, RemoteFailure } from '../connectors/remote-sources/http.js';
import { RemoteSourceError, normalizeSourceUrl } from '../connectors/remote-sources/http.js';
import { exchangePairingCode } from '../connectors/remote-sources/pair.js';
import type { PairedRemote } from '../connectors/remote-sources/store.js';
import { MAX_REMOTES, readRemotes, writeRemotes } from '../connectors/remote-sources/store.js';
import { remoteSourcesFrom } from '../app/remote-sources.js';
import type { Prompter } from './prompter.js';

export interface RemoteDeps {
  prompter: Prompter;
  secrets: SecretStore;
  /** `<ax-kit home>/remotes.json`. */
  file: string;
  now: () => Date;
  /** This Mac's name, shown on the other Mac as who paired. */
  thisMac?: string;
  post?: PostJson;
}

const FAILURE_TEXT: Record<RemoteFailure, string> = {
  unreachable: '그 맥에 닿지 않아요. 두 맥 모두 Tailscale에 로그인돼 있는지, 그 맥에서 `ax-kit source serve`(또는 `ax-kit source install`)가 켜져 있는지 봐 주세요.',
  unauthorized: '코드가 맞지 않거나 시간이 지났어요. 그 맥에서 `ax-kit source pair`로 새 코드를 받아 주세요.',
  refused: '그 맥이 요청을 거절했어요.',
  rate_limited: '짧은 시간에 너무 많이 시도했어요. 10분쯤 뒤에 다시 해 주세요.',
  bad_response: '그 주소에서 ax-kit이 아닌 다른 프로그램이 답했어요. 주소와 포트를 확인해 주세요.',
  timeout: '그 맥이 제때 답하지 않았어요. 잠자기 상태인지 확인해 주세요.',
};

export function failureText(error: unknown): string {
  return error instanceof RemoteSourceError ? FAILURE_TEXT[error.reason] : '알 수 없는 문제로 연결하지 못했어요.';
}

export interface RemoteCheck {
  folders: readonly string[];
  sessions: number;
  sharesSessions: boolean;
}

/** Asks the other Mac what it shares: folder list and how many coding sessions. */
export async function checkRemote(source: RemoteSource): Promise<RemoteCheck> {
  const info = await source.info();
  const sessions = info.sessions ? (await source.sessions.list()).length : 0;
  return { folders: info.folders, sessions, sharesSessions: info.sessions };
}

function sayCheck(prompter: Prompter, name: string, check: RemoteCheck): void {
  prompter.say(`연결됐어요: ${name} · 공유 폴더 ${check.folders.length}개 · Claude Code·Codex 대화 ${check.sessions}개`);
  for (const folder of check.folders.slice(0, 10)) prompter.say(`  - ${name}:${folder}`);
  if (!check.sharesSessions) prompter.say('  (그 맥에서 대화 기록은 공유하지 않기로 했어요)');
}

/**
 * Pairs one more Mac: its address and the code `ax-kit source pair` printed there, traded for a token kept in this
 * Mac's Keychain. Undefined when it did not work (the reason has been said).
 */
export async function addRemote(deps: RemoteDeps, given?: { url: string; code: string }): Promise<PairedRemote | undefined> {
  const { prompter } = deps;
  const existing = await readRemotes(deps.file);
  if (existing.length >= MAX_REMOTES) {
    prompter.say(`연결할 수 있는 맥은 ${MAX_REMOTES}대까지예요. \`ax-kit remote remove <이름>\`으로 하나 지운 뒤 해 주세요.`);
    return undefined;
  }
  // reported by the other Mac itself (remote install), or typed from what `ax-kit source pair` showed there
  const rawUrl = given?.url ?? (await prompter.text(`그 맥의 주소 (\`ax-kit source pair\`가 보여 준 것, 예: http://100.64.0.2:${DEFAULT_SOURCE_PORT})`, {
    validate: (value) => (normalizeSourceUrl(value) === undefined ? 'http://로 시작하는 주소로 적어 주세요.' : undefined),
  }));
  const url = normalizeSourceUrl(rawUrl) ?? rawUrl;
  const code = given?.code ?? (await prompter.text('연결 코드 (예: ABCD-EFGH)', { validate: (value) => (value.trim().length < 4 ? '코드를 적어 주세요.' : undefined) }));
  let paired;
  try {
    paired = await exchangePairingCode(url, code, deps.thisMac ?? hostname(), deps.post);
  } catch (error) {
    prompter.say(failureText(error));
    return undefined;
  }
  const taken = new Set(existing.map((remote) => remote.name.toLowerCase()));
  const suggested = remoteNameFrom(paired.host) || 'MacBook';
  const fallback = taken.has(suggested.toLowerCase()) ? `${suggested.slice(0, 29)}-2` : suggested;
  const name = await prompter.text('이 맥을 뭐라고 부를까요? (영문·숫자·-, 경로 앞에 "이름:"으로 보여요)', {
    default: fallback,
    validate: (value) => (!isRemoteName(value) ? '영문·숫자·-·_로 32자까지 적어 주세요.' : taken.has(value.toLowerCase()) ? '이미 있는 이름이에요.' : undefined),
  });
  await deps.secrets.set(remoteTokenSecret(name), paired.token);
  const remote: PairedRemote = { name, url, host: paired.host, addedAt: deps.now().toISOString() };
  await writeRemotes(deps.file, [...existing, remote]);
  const [source] = remoteSourcesFrom([remote], deps.secrets, deps.post);
  if (source !== undefined) {
    try {
      sayCheck(prompter, name, await checkRemote(source));
    } catch (error) {
      prompter.say(`저장은 했지만 확인하지 못했어요: ${failureText(error)}`);
    }
  }
  return remote;
}

/** `ax-kit remote list`: each paired Mac and whether it answers now. */
export async function listRemotes(deps: Omit<RemoteDeps, 'now'>): Promise<number> {
  const remotes = await readRemotes(deps.file);
  if (remotes.length === 0) {
    deps.prompter.say('연결된 다른 맥이 없어요. `ax-kit remote add`로 연결할 수 있어요.');
    return 0;
  }
  for (const [index, source] of remoteSourcesFrom(remotes, deps.secrets, deps.post).entries()) {
    const remote = remotes[index];
    if (remote === undefined) continue;
    let state: string;
    try {
      const check = await checkRemote(source);
      state = `연결됨 · 폴더 ${check.folders.length}개 · 대화 ${check.sessions}개`;
    } catch (error) {
      state = `응답 없음 (${error instanceof RemoteSourceError ? error.reason : 'error'})`;
    }
    deps.prompter.say(`${remote.name}  ${remote.url}  (${remote.host}) · ${state}`);
  }
  return 0;
}

/** `ax-kit remote remove <name>`: forgets the Mac and deletes its token from the Keychain. */
export async function removeRemote(deps: Omit<RemoteDeps, 'now'>, name: string): Promise<number> {
  const remotes = await readRemotes(deps.file);
  const target = remotes.find((remote) => remote.name.toLowerCase() === name.toLowerCase());
  if (target === undefined) {
    deps.prompter.say(`"${name}"라는 맥이 없어요. \`ax-kit remote list\`로 이름을 확인해 주세요.`);
    return 1;
  }
  await writeRemotes(deps.file, remotes.filter((remote) => remote !== target));
  await deps.secrets.delete(remoteTokenSecret(target.name));
  deps.prompter.say(`${target.name} 연결을 지웠어요. 그 맥에서도 끊으려면 거기서 \`ax-kit source revoke all\`을 실행해 주세요.`);
  deps.prompter.say('서버가 켜져 있다면 `ax-kit service install`(또는 다시 시작)로 반영돼요.');
  return 0;
}
