import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../core/config/schema.js';
import type { SecretStore } from '../core/secrets/types.js';
import { GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_SCOPE, GOOGLE_GMAIL_MODIFY_SCOPE } from '../connectors/google/oauth.js';
import type { Prompter } from './prompter.js';
import type { WorkspaceChoice } from './setup-google-workspace.js';
import { askWorkspace, workspaceApiLine, workspaceEntries, workspaceScopes } from './setup-google-workspace.js';
import type { AsideRunner } from './setup-google-aside.js';
import { prepareGoogleWithAside } from './setup-google-aside.js';
import type { AsideInstall } from './setup-google-aside-install.js';
import { installAside } from './setup-google-aside-install.js';

export interface ConnectGoogleOptions {
  secrets: SecretStore;
  clientJson: string;
  openUrl: (url: string) => Promise<void>;
  /** Extra opt-in scopes (e.g. Drive read-only). */
  extraScopes?: readonly string[];
}

export interface ConnectGoogleResult {
  grantedScopes: string[];
  missingScopes: string[];
}

export type ConnectGoogle = (opts: ConnectGoogleOptions) => Promise<ConnectGoogleResult>;

export interface GoogleStepDeps {
  prompter: Prompter;
  secrets: SecretStore;
  openUrl: (url: string) => Promise<void>;
  connectGoogle: ConnectGoogle;
  readFile: (path: string) => Promise<string>;
  fileExists: (path: string) => Promise<boolean>;
  existing?: Config;
  /** Aside CLI on this Mac: the Google Cloud side can be done in the owner's browser for them. */
  aside?: AsideRunner;
  /** No Aside yet: offered to install it here (app + CLI) and then prepare the same way. */
  asideInstall?: AsideInstall;
}

/** Present only after a successful connection; `false` means the user did not grant that scope. */
export interface GoogleStepResult {
  calendar?: boolean;
  gmail?: boolean;
  drive?: boolean;
  /** Gmail 정리 (gmail.modify): archive and labels. */
  organize?: boolean;
  /** Docs, Sheets, Tasks and Contacts connector entries to merge into config.plugins. */
  workspace?: Record<string, Record<string, unknown>>;
  /** Drive folders the owner pasted (ids from their links). */
  driveFolders?: string[];
}

/** Folder ids from what the owner pasted: Drive folder links (…/folders/<id>) or bare ids, comma or space separated. */
export function driveFolderIds(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((part) => /\/folders\/([A-Za-z0-9_-]{10,})/.exec(part)?.[1] ?? (/^[A-Za-z0-9_-]{20,}$/.test(part) ? part : '')).filter((id) => id !== ''))];
}

const CHECKLIST = [
  'a) 새 프로젝트: https://console.cloud.google.com/projectcreate',
  'b) API 사용 설정 (Gmail API, Google Calendar API): https://console.cloud.google.com/apis/library',
  'c) OAuth 동의 화면 (https://console.cloud.google.com/auth/overview): 외부(External), 앱 이름·내 이메일, 대상에 내 계정을 테스트 사용자로 추가',
  'd) 중요: 게시 상태를 "프로덕션으로 게시"로 바꾸세요 — "테스트" 상태면 연결이 7일마다 끊겨요. 게시 후 로그인할 때 "확인되지 않은 앱" 경고가 나오면 "고급 > (앱 이름)(으)로 이동"을 눌러 계속하면 돼요 (내가 만든 내 앱이라 괜찮아요).',
  'e) 클라이언트 만들기 (https://console.cloud.google.com/auth/clients): 유형 "데스크톱 앱" -> JSON 다운로드',
];

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Words that mean "not now" at the file question, so nobody is stuck in it. */
const SKIP = /^(건너뛰기|나중에|skip|later|q)$/i;

/** The OAuth client file, or undefined when the owner skips (say "나중에", or three tries that find no file). */
export async function askClientJson(deps: GoogleStepDeps): Promise<string | undefined> {
  for (let tries = 0; tries < 3; tries += 1) {
    const answer = (await deps.prompter.text('내려받은 OAuth 클라이언트 JSON 파일 경로 (Finder에서 파일을 끌어다 놓아도 돼요 · 나중에 하려면 "나중에")', {
      validate: (value) => (value.trim().length === 0 ? '경로를 넣거나 "나중에"라고 써 주세요.' : undefined),
    })).trim().replace(/^['"]|['"]$/g, '');
    if (SKIP.test(answer)) return undefined;
    const path = expandHome(answer);
    if (!(await deps.fileExists(path))) {
      deps.prompter.say(`파일을 찾지 못했어요: ${path}`);
      continue;
    }
    try {
      return await deps.readFile(path);
    } catch (error) {
      deps.prompter.say(`파일을 읽지 못했어요: ${errorMessage(error)}`);
    }
  }
  deps.prompter.say('Google은 나중에 연결해요. 준비되면 `ax-kit connect google`을 실행해 주세요.');
  return undefined;
}

/** Runs the Google checklist and OAuth flow, or skips it for `ax-kit connect google` later. */
export async function askGoogle(deps: GoogleStepDeps): Promise<GoogleStepResult> {
  const choice = await deps.prompter.choose(
    'Google을 지금 연결할까요?',
    [
      ...(deps.aside !== undefined ? [{ value: 'aside', label: '브라우저가 대신 준비하고 연결 (추천)' }] : []),
      ...(deps.aside === undefined && deps.asideInstall !== undefined
        ? [{ value: 'aside-install', label: 'Aside를 설치하고 브라우저가 대신 준비 (추천)', hint: 'Aside 브라우저가 Google Cloud 설정을 대신 해요. 설치는 몇 분이면 돼요.' }]
        : []),
      { value: 'connect', label: deps.aside !== undefined || deps.asideInstall !== undefined ? '직접 준비하고 연결 (안내 보기)' : '지금 연결 (메일·캘린더)' },
      { value: 'later', label: '나중에 (ax-kit connect google)' },
    ],
    0,
  );
  if (choice === 'later') {
    deps.prompter.say('Google 연결은 `ax-kit connect google`로 나중에 할 수 있어요.');
    return {};
  }

  const aside = choice === 'aside' ? deps.aside : choice === 'aside-install' && deps.asideInstall !== undefined ? await installAside(deps.prompter, deps.asideInstall) : undefined;
  let clientJson = aside !== undefined ? await prepareGoogleWithAside({ prompter: deps.prompter, aside, readFile: deps.readFile }) : undefined;
  if (clientJson === undefined) {
    deps.prompter.say('Google Cloud에서 내 OAuth 클라이언트를 만들어 주세요:');
    for (const line of CHECKLIST) deps.prompter.say(`  ${line}`);
    if (deps.existing?.plugins['connector.google-calendar']?.enabled !== true) {
      deps.prompter.say('  (연결하면 메일·일정 도구가 함께 켜져요.)');
    }
    clientJson = await askClientJson(deps);
    if (clientJson === undefined) return {};
  }
  const driveOn = deps.existing?.plugins['connector.google-drive']?.enabled === true;
  const organizeOn = deps.existing?.plugins['connector.gmail']?.['organize'] === true;
  const extraChoice = await deps.prompter.choose(
    '메일·캘린더 말고 더 맡길 일이 있나요? (나중에 ax-kit connect google로 바꿀 수 있어요)',
    [
      { value: 'none', label: '아니요 (기본)' },
      { value: 'drive', label: 'Google Drive 폴더 읽기 (읽기 전용)' },
      { value: 'organize', label: 'Gmail 정리 (보관·라벨 붙이기, 메일을 지우지는 않아요)' },
      { value: 'both', label: '둘 다' },
    ],
    // The default keeps what is on now: this sign-in replaces the old grant.
    (driveOn ? 1 : 0) + (organizeOn ? 2 : 0),
  );
  const drive = extraChoice === 'drive' || extraChoice === 'both';
  const organize = extraChoice === 'organize' || extraChoice === 'both';
  const workspace = await askWorkspace(deps.prompter, deps.existing);
  const apiLine = workspaceApiLine(workspace);
  if (apiLine !== undefined) deps.prompter.say(apiLine);
  return await signInAndSave(deps, clientJson, { drive, organize, workspace });
}

/** The opt-in parts one sign-in asks for. Google replaces the old grant, so this must name every part to keep. */
export interface GoogleWanted {
  drive: boolean;
  organize: boolean;
  workspace: WorkspaceChoice;
}

export function wantedScopes(wanted: GoogleWanted): string[] {
  return [
    ...new Set([
      ...(wanted.drive ? [GOOGLE_DRIVE_SCOPE, GOOGLE_DRIVE_FILE_SCOPE] : []),
      ...(wanted.organize ? [GOOGLE_GMAIL_MODIFY_SCOPE] : []),
      ...workspaceScopes(wanted.workspace),
    ]),
  ];
}

/** Opens the Google sign-in for the default scopes plus `wanted`, then says in Korean what got connected. */
export async function signInAndSave(deps: GoogleStepDeps, clientJson: string, wanted: GoogleWanted): Promise<GoogleStepResult> {
  const extraScopes = wantedScopes(wanted);
  try {
    // A browser that fails to open must not end the sign-in: the user can paste the link instead.
    const openUrl = async (url: string): Promise<void> => {
      deps.prompter.say('브라우저에서 Google 로그인 화면이 열려요. 열리지 않으면 이 주소를 직접 여세요:');
      deps.prompter.say(`  ${url}`);
      try {
        await deps.openUrl(url);
      } catch {
        // The link above is enough.
      }
    };
    const result = await deps.connectGoogle({
      secrets: deps.secrets,
      clientJson,
      openUrl,
      ...(extraScopes.length > 0 ? { extraScopes } : {}),
    });
    const calendarMissing = result.missingScopes.some((scope) => scope.includes('/calendar.'));
    // gmail.modify is the opt-in "Gmail 정리": declining it leaves reading and drafting connected.
    const gmailMissing = result.missingScopes.some((scope) => scope.includes('/gmail.') && scope !== GOOGLE_GMAIL_MODIFY_SCOPE);
    deps.prompter.say(calendarMissing ? '캘린더 권한을 허용하지 않아 캘린더 연결은 건너뛸게요.' : 'Google 캘린더를 연결했어요.');
    deps.prompter.say(gmailMissing ? 'Gmail 권한을 허용하지 않아 메일 연결은 건너뛸게요.' : 'Gmail을 연결했어요.');
    const drive = wanted.drive && !result.missingScopes.includes(GOOGLE_DRIVE_SCOPE);
    if (wanted.drive) {
      deps.prompter.say(drive ? 'Google Drive를 읽기 전용으로 연결했어요.' : 'Drive 권한을 허용하지 않아 Drive 연결은 건너뛸게요.');
    }
    const folders = deps.existing?.plugins['connector.google-drive']?.folderIds;
    let driveFolders: string[] | undefined;
    if (drive && !(Array.isArray(folders) && folders.length > 0)) {
      // a link pasted from the browser, not a setting to edit by hand
      const pasted = await deps.prompter.text('비서가 읽을 Drive 폴더 주소를 붙여 넣어 주세요 (브라우저에서 폴더를 열고 주소창 복사 · 여러 개는 쉼표 · 비우면 나중에)', { default: '' });
      driveFolders = driveFolderIds(pasted);
      deps.prompter.say(driveFolders.length > 0 ? `✓ Drive 폴더 ${driveFolders.length}개를 읽을게요.` : 'Drive 폴더는 나중에 알려 주세요. 대화에서 "이 Drive 폴더 읽어 줘"라고 주소를 보내도 돼요.');
    }
    const organize = wanted.organize && !gmailMissing && !result.missingScopes.includes(GOOGLE_GMAIL_MODIFY_SCOPE);
    if (wanted.organize) {
      deps.prompter.say(
        organize
          ? 'Gmail 정리(보관·라벨)를 맡길 수 있게 됐어요. 메일을 지우거나 휴지통에 넣지는 않아요.'
          : 'Gmail 정리 권한을 허락하지 않아 보관·라벨 기능은 건너뛸게요.',
      );
    }
    const entries = workspaceEntries(wanted.workspace, result.missingScopes, deps.prompter, deps.existing);
    return { calendar: !calendarMissing, gmail: !gmailMissing, drive, organize, ...(Object.keys(entries).length > 0 ? { workspace: entries } : {}), ...(driveFolders !== undefined && driveFolders.length > 0 ? { driveFolders } : {}) };
  } catch (error) {
    deps.prompter.say(`Google 연결에 실패했어요: ${errorMessage(error)}`);
    deps.prompter.say('설정은 계속 진행할게요. 나중에 `ax-kit connect google`로 다시 시도할 수 있어요.');
    return {};
  }
}

/**
 * The Gmail connector entry to save. `organize` follows this sign-in: a new consent without gmail.modify replaces the
 * old token, so the flag goes too. Other keys the owner wrote are kept.
 */
export function gmailPluginEntry(existing: Config | undefined, google: GoogleStepResult): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...(existing?.plugins['connector.gmail'] ?? {}) };
  delete rest['organize'];
  return { ...rest, enabled: google.gmail === true, ...(google.gmail === true && google.organize === true ? { organize: true } : {}) };
}

/** The Drive connector entry to save; folder ids the owner already wrote are kept. */
export function drivePluginEntry(existing: Config | undefined, enabled: boolean, added: readonly string[] = []): Record<string, unknown> {
  const previous = existing?.plugins['connector.google-drive']?.folderIds;
  return { enabled, folderIds: [...new Set([...(Array.isArray(previous) ? (previous as string[]) : []), ...added])] };
}
