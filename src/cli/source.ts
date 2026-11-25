import { join } from 'node:path';
import type { Prompter } from './prompter.js';
import { DEFAULT_SOURCE_PORT } from '../core/remote/protocol.js';
import type { SourceConfig } from '../app/source/config.js';
import { readSourceConfig, sourceConfigFile, writeSourceConfig } from '../app/source/config.js';
import { SourceTokens } from '../app/source/tokens.js';
import type { Exec } from './tailscale.js';
import { findTailscale, tailscaleStatus } from './tailscale.js';

/** Folders a work Mac usually keeps work in; only the ones that exist are offered. */
const CANDIDATES = ['Documents', 'Desktop', 'dev', 'Developer', 'projects', 'code', 'src', 'workspace', 'work'];
const MAX_FOLDERS = 30;

export interface SourceSetupDeps {
  prompter: Prompter;
  sourceHome: string;
  home: string;
  dirExists: (path: string) => Promise<boolean>;
}

function expand(raw: string, home: string): string | undefined {
  const value = raw.trim();
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return value.startsWith('/') ? value : undefined;
}

function shown(path: string, home: string): string {
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function numbers(value: string, max: number): number[] | undefined {
  if (value.trim() === '') return [];
  const parts = value.split(/[\s,]+/).filter((part) => part !== '');
  const list = parts.map((part) => Number.parseInt(part, 10));
  return list.every((n, i) => String(n) === parts[i] && n >= 1 && n <= max) ? list : undefined;
}

/** The folder checklist: suggestions that exist (and earlier picks), numbers to leave out, then paths typed in. */
async function askSharedFolders(deps: SourceSetupDeps, previous: readonly string[]): Promise<string[]> {
  const { prompter, home } = deps;
  const scope = await prompter.choose(
    '이 맥의 어디까지 보여 줄까요?',
    [
      { value: 'all', label: '모든 파일 (홈 폴더 전체, 추천)', hint: '키·비밀번호·.env·.ssh처럼 보이는 파일은 그래도 열지 않아요.' },
      { value: 'pick', label: '폴더만 고르기' },
    ],
    previous.length > 0 && !previous.includes('~') ? 1 : 0,
  );
  if (scope === 'all') return ['~'];
  const offered = [...previous];
  for (const name of CANDIDATES) {
    const path = `~/${name}`;
    if (!offered.includes(path) && (await deps.dirExists(join(home, name)))) offered.push(path);
  }
  if (offered.length > 0) {
    prompter.say('다른 맥(비서가 있는 맥)에 보여 줄 폴더 (기본 제안):');
    offered.forEach((path, index) => prompter.say(`  ${index + 1}) ${path}`));
  }
  const removeAnswer =
    offered.length === 0
      ? ''
      : await prompter.text('뺄 번호 (쉼표로, 없으면 엔터)', {
          validate: (value) => (numbers(value, offered.length) === undefined ? '목록의 번호로 적어 주세요.' : undefined),
        });
  const removed = new Set(numbers(removeAnswer, offered.length) ?? []);
  const folders = offered.filter((_, index) => !removed.has(index + 1));
  const extra = await prompter.text('직접 입력: 더할 폴더 경로 (쉼표로, 없으면 엔터)', { default: '' });
  for (const raw of extra.split(',').map((part) => part.trim()).filter((part) => part !== '')) {
    const absolute = expand(raw, home);
    if (absolute === undefined) {
      prompter.say(`건너뛸게요(절대 경로나 ~/로 적어 주세요): ${raw}`);
      continue;
    }
    if (!(await deps.dirExists(absolute))) {
      prompter.say(`폴더를 찾지 못해 건너뛸게요: ${raw}`);
      continue;
    }
    const path = shown(absolute, home);
    if (!folders.includes(path)) folders.push(path);
  }
  return folders.slice(0, MAX_FOLDERS);
}

/** `ax-kit source setup`: which folders (and whether the coding sessions) this Mac shows the assistant's Mac. */
export async function runSourceSetup(deps: SourceSetupDeps): Promise<SourceConfig> {
  const { prompter } = deps;
  const previous = await readSourceConfig(deps.sourceHome);
  prompter.say('이 맥의 파일을 다른 맥에 있는 비서가 읽을 수 있게 해요 (읽기만).');
  prompter.say('- 키·비밀번호·.env·.ssh·여권·통장처럼 보이는 이름은 열지 않아요. 아무것도 바꾸거나 지우지 않아요.');
  prompter.say('- 연결은 Tailscale(내 기기끼리만 통하는 암호화된 망) 안에서만, 짝지은 맥만 할 수 있어요.');
  const folders = await askSharedFolders(deps, previous?.folders ?? []);
  const sessions = await prompter.choose(
    '이 맥의 Claude Code·Codex 대화 기록도 보여 줄까요? (비밀값은 가리고, 도구 출력은 빼요)',
    [
      { value: 'yes', label: '네' },
      { value: 'no', label: '아니요' },
    ],
    previous?.sessions === false ? 1 : 0,
  );
  const config: SourceConfig = { folders, sessions: sessions === 'yes', port: previous?.port ?? DEFAULT_SOURCE_PORT };
  await writeSourceConfig(deps.sourceHome, config);
  prompter.say(folders.length > 0 ? `보여 줄 폴더: ${folders.join(', ')}` : '폴더는 고르지 않았어요 (대화 기록만 보여요).');
  prompter.say(`저장했어요: ${sourceConfigFile(deps.sourceHome)}`);
  return config;
}

/** This Mac's Tailscale IPv4 ("100.x.y.z"); undefined when Tailscale is off or missing. */
export async function tailscaleIp(exec: Exec): Promise<string | undefined> {
  const bin = await findTailscale(exec);
  if (bin === undefined) return undefined;
  try {
    const result = await exec(bin, ['ip', '-4']);
    const ip = result.stdout.split('\n').map((line) => line.trim()).find((line) => /^\d{1,3}(\.\d{1,3}){3}$/.test(line));
    return result.code === 0 ? ip : undefined;
  } catch {
    return undefined;
  }
}

export interface SourcePairDeps {
  sourceHome: string;
  exec: Exec;
  say: (line: string) => void;
  now?: () => Date;
  /** Sends the address and code to the assistant's Mac (an install link) so it pairs by itself; true when taken. */
  report?: (url: string, code: string) => Promise<boolean>;
}

/** `ax-kit source pair`: a ten-minute code and the address to type on the assistant's Mac. */
export async function runSourcePair(deps: SourcePairDeps): Promise<number> {
  const config = await readSourceConfig(deps.sourceHome);
  if (config === undefined) {
    deps.say('먼저 `ax-kit source setup`으로 보여 줄 폴더를 골라 주세요.');
    return 1;
  }
  const [ip, status] = await Promise.all([tailscaleIp(deps.exec), tailscaleStatus(deps.exec)]);
  if (ip === undefined) {
    deps.say('Tailscale이 꺼져 있거나 설치되지 않았어요. Tailscale 앱에 로그인한 뒤 다시 해 주세요.');
    return 1;
  }
  const code = await new SourceTokens({ dir: deps.sourceHome, ...(deps.now !== undefined ? { now: deps.now } : {}) }).startPairing();
  if (deps.report !== undefined && (await deps.report(`http://${ip}:${config.port}`, code).catch(() => false))) {
    deps.say('✓ 비서의 맥에 연결 코드를 보냈어요. 그 맥이 알아서 연결을 마쳐요.');
    return 0;
  }
  deps.say('비서가 있는 맥에서 `ax-kit remote add`(또는 setup의 "다른 맥" 단계)에 아래를 입력하세요. 10분 동안 한 번만 쓸 수 있어요.');
  deps.say(`  주소: http://${ip}:${config.port}`);
  if (status.dnsName !== undefined) deps.say(`  (또는 http://${status.dnsName}:${config.port})`);
  deps.say(`  코드: ${code}`);
  deps.say('이 맥에서 `ax-kit source serve`가 켜져 있어야 해요 (`ax-kit source install`로 자동 시작).');
  return 0;
}
