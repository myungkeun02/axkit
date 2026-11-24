import type { Config } from '../core/config/schema.js';
import type { SecretStore } from '../core/secrets/types.js';
import { chooseMany } from './prompt-kit.js';
import type { Prompter } from './prompter.js';
import { FEATURES, GITHUB_TOKEN_SECRET, remindersSource } from './setup-optional.js';
import type { OptionalPlugins } from './setup-optional.js';

/** On from the first setup, no question: everyday work, each risky action still confirmed one by one. */
export const BASIC_ON: readonly string[] = [
  'connector.browser',
  'skill.browser',
  'skill.errands',
  'connector.macos-ocr',
  'connector.mac-apps',
  'connector.apple-reminders',
  'skill.tuning',
  'skill.company',
];

/** Asked once: reading another app's screen can get that account limited by the app's own rules. */
const ASKED: readonly string[] = ['connector.kakao-desktop', 'connector.discord-app'];

export interface BasicStepDeps {
  prompter: Prompter;
  secrets: SecretStore;
  existing?: Config;
  /** Chromium for the browser errands; true when it is there (after installing it if needed). */
  ensureBrowser?: () => Promise<boolean>;
  /** Meeting transcription on this Mac; true when ready. */
  installTranscriber?: () => Promise<boolean>;
  /** Whether this Mac has code projects (git folders): GitHub is asked about only then. */
  hasCode?: () => Promise<boolean>;
  /** GitHub through the gh CLI. */
  github?: {
    /** The token of the account gh is signed in with, or undefined. */
    token: () => Promise<string | undefined>;
    /** `gh auth login` + `gh auth setup-git` on this terminal; the exit code. */
    login: () => Promise<number>;
  };
}

export interface BasicStepResult {
  plugins: OptionalPlugins;
  browser?: boolean;
  transcribe?: boolean;
  github: 'connected' | 'later';
}

function titleOf(id: string): string {
  return FEATURES.find((feature) => feature.ids.includes(id))?.title ?? id;
}

async function connectGithub(prompter: Prompter, deps: BasicStepDeps): Promise<'connected' | 'later'> {
  if (await deps.secrets.has(GITHUB_TOKEN_SECRET)) return 'connected';
  // most people have no code here: GitHub is not their business, so it is not asked
  if (deps.hasCode !== undefined && !(await deps.hasCode().catch(() => false))) return 'later';
  const github = deps.github;
  const signedIn = await github?.token().catch(() => undefined);
  if (signedIn !== undefined) {
    const use = await prompter.choose(
      '이 맥에 코드 프로젝트가 있고 GitHub에 로그인돼 있어요. 비서가 그 로그인으로 개발을 도와도 될까요?',
      [
        { value: 'yes', label: '네, 그 로그인 쓰기', hint: '개발 보조가 브랜치·초안 PR을 만들 때만 써요' },
        { value: 'later', label: '나중에' },
      ],
      0,
    );
    if (use !== 'yes') return 'later';
    await deps.secrets.set(GITHUB_TOKEN_SECRET, signedIn);
    prompter.say('✓ GitHub: 이 맥의 gh 로그인을 써요.');
    return 'connected';
  }
  const choice = await prompter.choose(
    'GitHub를 연결할까요? (개발 프로젝트를 이 맥에서 고치고 초안 PR까지 만들어요)',
    [
      ...(github !== undefined ? [{ value: 'login', label: '지금 로그인 (추천)', hint: 'gh auth login: 브라우저에서 로그인하고 돌아오세요.' }] : []),
      { value: 'token', label: '토큰 직접 넣기', hint: 'Contents·Pull requests 쓰기, Issues 읽기 권한의 토큰' },
      { value: 'later', label: '나중에', hint: 'gh auth login 또는 ax-kit secret set github.token' },
    ],
    0,
  );
  if (choice === 'login' && github !== undefined) {
    await github.login();
    const token = await github.token().catch(() => undefined);
    if (token === undefined) {
      prompter.say('아직 로그인되지 않았어요. 나중에 `gh auth login` 후 `ax-kit setup`을 다시 하면 돼요.');
      return 'later';
    }
    await deps.secrets.set(GITHUB_TOKEN_SECRET, token);
    prompter.say('✓ GitHub 연결됐어요.');
    return 'connected';
  }
  if (choice === 'token') {
    const token = (await prompter.secret('GitHub 토큰: ')).trim();
    if (token !== '') {
      await deps.secrets.set(GITHUB_TOKEN_SECRET, token);
      return 'connected';
    }
  }
  return 'later';
}

/**
 * The basics, installed and switched on in the first setup: browser and everyday errands (stop before paying),
 * receipts OCR, Mac app control and Reminders (each action confirmed), self-tuning, team bots and the dev helper.
 * Only what needs an account (GitHub) or reads another app's screen (KakaoTalk, Discord) is asked.
 */
export async function setupBasics(deps: BasicStepDeps): Promise<BasicStepResult> {
  const { prompter, existing } = deps;
  prompter.say('기본으로 켜는 기능이에요 (보내기·결제·예약 확정은 늘 직접 확인해요):');
  for (const id of BASIC_ON.filter((item, index) => titleOf(item) !== titleOf(BASIC_ON[index - 1] ?? ''))) prompter.say(`  ✓ ${titleOf(id)}`);
  const plugins: OptionalPlugins = {};
  // a basic the owner turned off by hand stays off when setup runs again
  for (const id of BASIC_ON) plugins[id] = { ...(existing?.plugins[id] ?? {}), enabled: existing?.plugins[id]?.enabled !== false };
  const todo = remindersSource(existing, true);
  if (todo !== undefined) plugins['skill.todo'] = todo;

  const browser = deps.ensureBrowser === undefined ? undefined : await deps.ensureBrowser().catch(() => false);
  if (browser === false) prompter.say('브라우저(Chromium)를 받지 못했어요. 나중에 `npx playwright install chromium`을 실행해 주세요.');
  const transcribe = deps.installTranscriber === undefined ? undefined : await deps.installTranscriber().catch(() => false);
  const github = await connectGithub(prompter, deps);

  const reading = new Set(
    await chooseMany(
      prompter,
      '다른 앱 화면도 읽을까요? (그 앱의 규칙상 계정이 제한될 수 있어서 직접 고르세요)',
      ASKED.map((id) => ({ value: id, label: titleOf(id), checked: existing?.plugins[id]?.enabled === true })),
    ),
  );
  for (const id of ASKED) plugins[id] = { ...(existing?.plugins[id] ?? {}), enabled: reading.has(id) };
  return { plugins, ...(browser !== undefined ? { browser } : {}), ...(transcribe !== undefined ? { transcribe } : {}), github };
}
