import type { Config } from '../core/config/schema.js';
import { OAUTH_CLIENT_SECRET } from '../connectors/google/token.js';
import { isRecord } from '../connectors/google/json.js';
import type { GoogleStepDeps, GoogleStepResult, GoogleWanted } from './setup-google.js';
import { askClientJson, signInAndSave } from './setup-google.js';
import type { WorkspaceChoice } from './setup-google-workspace.js';
import { DOCS_OPTIONS, SHEETS_OPTIONS, currentWorkspace, pick, workspaceApiLine, yesNo } from './setup-google-workspace.js';

/** Feature-table ids of the Google parts this step can turn on with one more sign-in. */
export const GOOGLE_OPT_IN_IDS = ['gmail-organize', 'drive', 'docs', 'docs-edit', 'sheets', 'sheets-write', 'tasks', 'contacts'] as const;

const NAMES: Readonly<Record<(typeof GOOGLE_OPT_IN_IDS)[number], string>> = {
  'gmail-organize': 'Gmail 정리',
  drive: 'Google Drive 읽기',
  docs: 'Google 문서',
  'docs-edit': 'Google 문서 고치기',
  sheets: 'Google 시트',
  'sheets-write': 'Google 시트 고치기',
  tasks: 'Google Tasks',
  contacts: 'Google 주소록',
};

/** What is on now, so the new sign-in asks for it again: Google drops whatever a new consent leaves out. */
export function currentWanted(existing: Config | undefined): GoogleWanted {
  return {
    drive: existing?.plugins['connector.google-drive']?.enabled === true,
    organize: existing?.plugins['connector.gmail']?.enabled === true && existing.plugins['connector.gmail']['organize'] === true,
    workspace: currentWorkspace(existing),
  };
}

function onNames(wanted: GoogleWanted): string[] {
  const { workspace } = wanted;
  return [
    '캘린더',
    'Gmail',
    ...(wanted.organize ? ['Gmail 정리'] : []),
    ...(wanted.drive ? ['Drive'] : []),
    ...(workspace.docs === 'edit' ? ['문서(고치기)'] : workspace.docs !== 'no' ? ['문서'] : []),
    ...(workspace.sheets === 'write' ? ['시트(고치기)'] : workspace.sheets !== 'no' ? ['시트'] : []),
    ...(workspace.tasks ? ['Tasks'] : []),
    ...(workspace.contacts ? ['주소록'] : []),
  ];
}

/** The saved OAuth client, as the "Desktop app" JSON the sign-in reads, so the owner need not find the file again. */
async function savedClientJson(deps: GoogleStepDeps): Promise<string | undefined> {
  const raw = await deps.secrets.get(OAUTH_CLIENT_SECRET).catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || typeof parsed.clientId !== 'string' || typeof parsed.clientSecret !== 'string') return undefined;
    return JSON.stringify({ installed: { client_id: parsed.clientId, client_secret: parsed.clientSecret } });
  } catch {
    return undefined;
  }
}

/**
 * `ax-kit setup` → "꺼진 것만": Google is connected but some opt-in parts are off. Asks only about those, then signs in
 * once for everything that is on now plus what the owner picked. Returns {} when nothing was picked.
 */
export async function askGoogleMissing(deps: GoogleStepDeps, off: ReadonlySet<string>): Promise<GoogleStepResult> {
  const { prompter } = deps;
  const current = currentWanted(deps.existing);
  // "Google 문서"/"Google 시트" off covers its 고치기 part; Tasks can be off only because the to-do list is pinned to this Mac.
  const skip = (id: string): boolean =>
    (id === 'docs-edit' && off.has('docs')) || (id === 'sheets-write' && off.has('sheets')) || (id === 'tasks' && current.workspace.tasks);
  const offIds = GOOGLE_OPT_IN_IDS.filter((id) => off.has(id) && !skip(id));
  if (offIds.length === 0) return {};
  prompter.say(`꺼진 Google 기능: ${offIds.map((id) => NAMES[id]).join(', ')}`);
  prompter.say(
    `켜려면 Google에 한 번 더 로그인해요. 새 로그인이 이전 권한을 바꾸기 때문에 지금 켜진 것(${onNames(current).join(', ')})도 ` +
      '함께 다시 요청해요. 로그인 화면에서 모두 체크해 주세요.',
  );
  if (!(await yesNo(prompter, '꺼진 Google 기능 중에서 골라 켤까요?', true))) return {};

  const added: WorkspaceChoice = { docs: 'no', sheets: 'no', tasks: false, contacts: false };
  const has = (id: (typeof GOOGLE_OPT_IN_IDS)[number]): boolean => offIds.includes(id);
  const organize = has('gmail-organize') && (await yesNo(prompter, 'Gmail 정리를 켤까요? (보관·라벨 붙이기, 메일을 지우지는 않아요)', false));
  const drive = has('drive') && (await yesNo(prompter, 'Google Drive 폴더 읽기를 켤까요? (읽기 전용)', false));
  if (has('docs')) added.docs = await pick(prompter, 'Google 문서(Docs)는 어떻게 할까요?', DOCS_OPTIONS, 'no');
  if (has('docs-edit')) {
    const edit = await yesNo(prompter, 'Google 문서 고치기를 켤까요? (내가 고칠 수 있는 모든 문서에 덧붙이기·문구 바꾸기, 고칠 때마다 확인 카드)', false);
    if (edit) added.docs = 'edit';
  }
  if (has('sheets')) added.sheets = await pick(prompter, 'Google 시트(Sheets)는 어떻게 할까요?', SHEETS_OPTIONS, 'no');
  if (has('sheets-write')) {
    const write = await yesNo(prompter, 'Google 시트를 "읽기 + 고치기"로 바꿀까요? (행 추가·칸 고치기, 고칠 때마다 확인 카드)', false);
    if (write) added.sheets = 'write';
  }
  if (has('tasks')) added.tasks = await yesNo(prompter, 'Google Tasks를 할 일 목록으로 쓸까요? (이 맥의 할 일 목록 대신)', false);
  if (has('contacts')) added.contacts = await yesNo(prompter, 'Google 주소록(Contacts)을 읽게 할까요? (읽기 전용)', false);

  const anyAdded = organize || drive || added.docs !== 'no' || added.sheets !== 'no' || added.tasks || added.contacts;
  if (!anyAdded) {
    prompter.say('Google은 그대로 둘게요.');
    return {};
  }
  // an upgrade of a part that is already on needs no new API switched on
  const apiLine = workspaceApiLine({ ...added, ...(current.workspace.sheets !== 'no' ? { sheets: 'no' as const } : {}) });
  if (apiLine !== undefined) prompter.say(apiLine);

  const now = current.workspace;
  const wanted: GoogleWanted = {
    drive: current.drive || drive,
    organize: current.organize || organize,
    workspace: {
      docs: added.docs !== 'no' ? added.docs : now.docs,
      sheets: added.sheets !== 'no' ? added.sheets : now.sheets,
      tasks: now.tasks || added.tasks,
      contacts: now.contacts || added.contacts,
    },
  };
  const clientJson = (await savedClientJson(deps)) ?? (await askClientJson(deps));
  if (clientJson === undefined) return {};
  return await signInAndSave(deps, clientJson, wanted);
}
