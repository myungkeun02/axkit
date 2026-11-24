import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { Config } from '../core/config/schema.js';
import type { PickedProject, ProjectCandidate } from '../skills/onboarding/projects.js';
import { chooseMany } from './prompt-kit.js';
import type { Prompter } from './prompter.js';
import { askProjects } from './setup-projects.js';
import { discoverOnThisComputer } from '../app/discover-projects.js';
import type { WorkPlaceStep } from './setup-remote.js';

export const ONBOARDING_ID = 'skill.onboarding';

/** Folders most people keep their work in; only the ones that exist are offered. */
const CANDIDATES = ['Documents', 'Desktop', 'Downloads', 'projects', 'dev', 'Developer', 'code', 'src', 'workspace', 'work'];
const MAX_FOLDERS = 30;

/** Short on purpose: what it reads, what it never opens, where the result goes. The full detail is in the app. */
const NOTICE = [
  '고른 폴더와 연결한 기능을 훑어 "내가 어떤 일을 하는 사람인지"를 문서로 정리해요. 처음 한 번은 오래 걸릴 수 있어요.',
  '키·비밀번호·.env·.ssh·여권·통장처럼 보이는 파일은 열지 않아요. 모델에는 원문 대신 가린 한 줄 요약만 보내요.',
  '끝나면 "제가 이해한 당신" 카드를 보내요. 틀린 줄은 고치면 돼요. 대화창에서 "알아보기 멈춰"로 멈출 수 있어요.',
  'macOS가 문서·데스크탑·다운로드 폴더 접근을 물으면 허용해 주세요 (안 하면 그 폴더만 건너뛰어요).',
];

export interface OnboardingStepDeps {
  prompter: Prompter;
  home: string;
  dirExists: (path: string) => Promise<boolean>;
  existing?: Config;
  /** Drive was connected in this setup or before. */
  driveConnected: boolean;
  now: () => Date;
  /** Projects in these folders and in Claude Code / Codex sessions; without it no project question is asked. */
  discover?: (folders: readonly string[]) => Promise<ProjectCandidate[]>;
  /** "Where are your work files": this Mac, another Mac (paired here), or both. Without it only this Mac is asked. */
  workPlace?: WorkPlaceStep;
}

function previousProjects(current: Record<string, unknown> | undefined): PickedProject[] {
  const raw = current?.['projects'];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is PickedProject =>
      typeof item === 'object' && item !== null && typeof (item as PickedProject).path === 'string' && typeof (item as PickedProject).name === 'string' && typeof (item as PickedProject).company === 'string',
  );
}

function display(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function expand(raw: string, home: string): string {
  return raw === '~' ? home : raw.startsWith('~/') ? join(home, raw.slice(2)) : raw;
}

/** The usual folders that exist (checked), plus any folder path the owner types in. */
async function askFolders(deps: OnboardingStepDeps): Promise<string[]> {
  const { prompter, home } = deps;
  const previous = deps.existing?.plugins[ONBOARDING_ID]?.['folders'];
  const offered: string[] = [];
  if (Array.isArray(previous)) offered.push(...previous.filter((item): item is string => typeof item === 'string'));
  for (const name of CANDIDATES) {
    const path = `~/${name}`;
    if (!offered.includes(path) && (await deps.dirExists(join(home, name)))) offered.push(path);
  }

  const answer = await chooseMany(
    prompter,
    '어느 폴더를 훑어볼까요?',
    offered.map((path) => ({ value: path, label: path, checked: true })),
    {
      type: {
        label: '다른 폴더 직접 입력',
        placeholder: '~/work 또는 /Volumes/드라이브',
        validate: (value) => (isAbsolute(expand(value, home)) ? undefined : '/ 또는 ~/로 시작하는 경로로 적어 주세요.'),
      },
    },
  );
  const folders: string[] = [];
  for (const raw of answer) {
    if (offered.includes(raw)) {
      folders.push(raw);
      continue;
    }
    const absolute = expand(raw, home);
    if (!isAbsolute(absolute)) {
      prompter.say(`건너뛸게요(절대 경로나 ~/로 적어 주세요): ${raw}`);
      continue;
    }
    if (!(await deps.dirExists(absolute))) {
      prompter.say(`폴더를 찾지 못해 건너뛸게요: ${raw}`);
      continue;
    }
    const shown = display(absolute, home);
    if (!folders.includes(shown)) folders.push(shown);
  }
  return folders.slice(0, MAX_FOLDERS);
}

/** Session logs, Drive and recent activity in one checklist instead of three yes/no questions. */
async function askSources(prompter: Prompter, sessionsAsked: boolean, driveConnected: boolean): Promise<Set<string>> {
  const options = [
    ...(sessionsAsked ? [{ value: 'sessions', label: '고른 프로젝트의 Claude·Codex 대화 기록', checked: true }] : []),
    ...(driveConnected ? [{ value: 'drive', label: 'Google Drive의 최근 문서', checked: true }] : []),
    { value: 'signals', label: '연결한 메일·캘린더·할 일·대화의 최근 흐름', checked: true },
  ];
  return new Set(await chooseMany(prompter, '폴더 말고 무엇을 더 참고할까요?', options));
}

/** The first-look step: may the assistant take a first look and write down who the owner is. */
export async function askOnboarding(deps: OnboardingStepDeps): Promise<Record<string, unknown>> {
  const { prompter } = deps;
  const current = deps.existing?.plugins[ONBOARDING_ID];
  for (const line of NOTICE) prompter.say(`  ${line}`);
  const choice = await prompter.choose(
    '처음 알아보기를 할까요?',
    [
      { value: 'now', label: '네, 바로 시작 (추천)', hint: '비서는 그동안에도 평소처럼 쓸 수 있어요.' },
      { value: 'later', label: '나중에', hint: '대화창에서 "처음 알아보기"라고 하면 시작해요.' },
      { value: 'off', label: '하지 않기' },
    ],
    current?.enabled === false ? 2 : 0,
  );
  if (choice === 'off') return { ...(current ?? {}), enabled: false };

  const place = deps.workPlace === undefined ? { local: true, folders: [] } : await deps.workPlace(prompter);
  const folders = [...(place.local ? await askFolders(deps) : []), ...place.folders];
  let projects = previousProjects(current);
  if (deps.discover !== undefined) {
    prompter.say('프로젝트를 찾는 중이에요…');
    let candidates: ProjectCandidate[] = [];
    try {
      candidates = await deps.discover(folders);
    } catch {
      prompter.say('프로젝트를 찾다가 문제가 생겨 건너뛸게요. 나중에 앱에서 고를 수 있어요.');
    }
    projects = await askProjects({ prompter, candidates, previous: projects, now: deps.now() });
  }
  const sessionsAsked = deps.discover !== undefined && projects.length > 0;
  const sources = await askSources(prompter, sessionsAsked, deps.driveConnected);
  prompter.say(folders.length > 0 ? `폴더: ${folders.join(', ')}` : '폴더는 고르지 않았어요.');
  return {
    ...(current ?? {}),
    enabled: true,
    autoStart: choice === 'now',
    folders,
    projects,
    sessions: sessionsAsked ? sources.has('sessions') : current?.['sessions'] !== false,
    depth: 'deep',
    drive: deps.driveConnected && sources.has('drive'),
    signals: sources.has('signals'),
    consentAt: deps.now().toISOString(),
  };
}

/** The real home folder and file system, for `ax-kit setup`. */
export function nodeOnboardingDeps(): {
  home: string;
  dirExists: (path: string) => Promise<boolean>;
  discover: (folders: readonly string[]) => Promise<ProjectCandidate[]>;
} {
  return {
    home: homedir(),
    discover: (folders) => discoverOnThisComputer(folders.map((folder) => expand(folder, homedir()))),
    dirExists: async (path) => {
      try {
        return (await stat(path)).isDirectory();
      } catch {
        return false;
      }
    },
  };
}
