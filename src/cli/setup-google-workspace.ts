import type { Config } from '../core/config/schema.js';
import { GOOGLE_DRIVE_FILE_SCOPE } from '../connectors/google/oauth.js';
import type { DocsLevel } from '../connectors/google/workspace-scopes.js';
import {
  GOOGLE_CONTACTS_READ_SCOPE,
  GOOGLE_DOCS_READ_SCOPE,
  GOOGLE_DOCS_SCOPE,
  GOOGLE_SHEETS_READ_SCOPE,
  GOOGLE_SHEETS_SCOPE,
  GOOGLE_TASKS_SCOPE,
  WORKSPACE_LABELS,
  docsLevelOf,
} from '../connectors/google/workspace-scopes.js';
import type { Prompter } from './prompter.js';

/** What the owner chose for Docs, Sheets, Tasks and Contacts in this sign-in. */
export interface WorkspaceChoice {
  docs: 'no' | DocsLevel;
  sheets: 'no' | 'read' | 'write';
  tasks: boolean;
  contacts: boolean;
}

export const WORKSPACE_PLUGIN_IDS = {
  docs: 'connector.google-docs',
  sheets: 'connector.google-sheets',
  tasks: 'connector.google-tasks',
  contacts: 'connector.google-contacts',
} as const;

const NONE: WorkspaceChoice = { docs: 'no', sheets: 'no', tasks: false, contacts: false };

const on = (existing: Config | undefined, id: string): boolean => existing?.plugins[id]?.enabled === true;

export async function yesNo(prompter: Prompter, question: string, current: boolean): Promise<boolean> {
  const answer = await prompter.choose(
    question,
    [
      { value: 'no', label: '아니요' },
      { value: 'yes', label: '네' },
    ],
    current ? 1 : 0,
  );
  return answer === 'yes';
}

/** The chosen option's value, typed; the default is the current one. */
export async function pick<T extends string>(
  prompter: Prompter,
  question: string,
  options: readonly { value: T; label: string }[],
  current: T,
): Promise<T> {
  const answer = await prompter.choose(question, options, Math.max(0, options.findIndex((option) => option.value === current)));
  return options.find((option) => option.value === answer)?.value ?? current;
}

export const DOCS_OPTIONS: readonly { value: WorkspaceChoice['docs']; label: string }[] = [
  { value: 'no', label: '연결 안 함' },
  { value: 'read', label: '읽기만' },
  { value: 'create', label: '읽기 + 새 문서 만들기 (덧붙이기는 ax-kit이 만든 문서에만)' },
  { value: 'edit', label: '읽기 + 문서 고치기 (내가 고칠 수 있는 모든 문서, 고칠 때마다 확인 카드)' },
];

export const SHEETS_OPTIONS: readonly { value: WorkspaceChoice['sheets']; label: string }[] = [
  { value: 'no', label: '연결 안 함' },
  { value: 'read', label: '읽기만' },
  { value: 'write', label: '읽기 + 행 추가·칸 고치기 (고칠 때마다 확인 카드)' },
];

/** What is switched on now, read from the saved connector entries. */
export function currentWorkspace(existing: Config | undefined): WorkspaceChoice {
  const sheetsWrite = existing?.plugins[WORKSPACE_PLUGIN_IDS.sheets]?.['write'] === true;
  return {
    docs: on(existing, WORKSPACE_PLUGIN_IDS.docs) ? docsLevelOf(existing?.plugins[WORKSPACE_PLUGIN_IDS.docs]) : 'no',
    sheets: on(existing, WORKSPACE_PLUGIN_IDS.sheets) ? (sheetsWrite ? 'write' : 'read') : 'no',
    tasks: on(existing, WORKSPACE_PLUGIN_IDS.tasks),
    contacts: on(existing, WORKSPACE_PLUGIN_IDS.contacts),
  };
}

/**
 * One gate question, then one per part. Every sign-in asks again: Google replaces the old grant, so a part left out
 * now stops working and is switched off.
 */
export async function askWorkspace(prompter: Prompter, existing: Config | undefined): Promise<WorkspaceChoice> {
  const current = currentWorkspace(existing);
  const any = current.docs !== 'no' || current.sheets !== 'no' || current.tasks || current.contacts;
  if (!(await yesNo(prompter, 'Google 문서·시트·할 일(Tasks)·주소록도 연결할까요? (하나씩 고를 수 있어요)', any))) return NONE;

  const docs = await pick(prompter, 'Google 문서(Docs)는 어떻게 할까요?', DOCS_OPTIONS, current.docs);
  const sheets = await pick(prompter, 'Google 시트(Sheets)는 어떻게 할까요?', SHEETS_OPTIONS, current.sheets);
  const tasks = await yesNo(prompter, 'Google Tasks를 할 일 목록으로 쓸까요? (이 맥의 할 일 목록 대신)', current.tasks);
  const contacts = await yesNo(prompter, 'Google 주소록(Contacts)을 읽어 이름으로 메일 주소·전화번호를 찾게 할까요? (읽기 전용)', current.contacts);
  return { docs, sheets, tasks, contacts };
}

/** Docs scopes per level: "문서 고치기" asks for `documents` instead of `documents.readonly`, never both. */
export function docsScopes(level: WorkspaceChoice['docs']): string[] {
  if (level === 'read') return [GOOGLE_DOCS_READ_SCOPE];
  if (level === 'create') return [GOOGLE_DOCS_READ_SCOPE, GOOGLE_DRIVE_FILE_SCOPE];
  if (level === 'edit') return [GOOGLE_DOCS_SCOPE];
  return [];
}

/** The scopes to request on top of the defaults. */
export function workspaceScopes(choice: WorkspaceChoice): string[] {
  const scopes: string[] = [...docsScopes(choice.docs)];
  if (choice.sheets === 'read') scopes.push(GOOGLE_SHEETS_READ_SCOPE);
  // read-only too, so declining "고치기" at Google still leaves reading on
  if (choice.sheets === 'write') scopes.push(GOOGLE_SHEETS_READ_SCOPE, GOOGLE_SHEETS_SCOPE);
  if (choice.tasks) scopes.push(GOOGLE_TASKS_SCOPE);
  if (choice.contacts) scopes.push(GOOGLE_CONTACTS_READ_SCOPE);
  return scopes;
}

/** The APIs the owner must switch on in Google Cloud for what they chose. */
export function workspaceApiLine(choice: WorkspaceChoice): string | undefined {
  const apis = [
    ...(choice.docs !== 'no' ? [WORKSPACE_LABELS.docs.api] : []),
    ...(choice.sheets !== 'no' ? [WORKSPACE_LABELS.sheets.api] : []),
    ...(choice.tasks ? [WORKSPACE_LABELS.tasks.api] : []),
    ...(choice.contacts ? [WORKSPACE_LABELS.contacts.api] : []),
  ];
  if (apis.length === 0) return undefined;
  return `Google Cloud의 API 라이브러리(https://console.cloud.google.com/apis/library)에서 ${apis.join(', ')}도 "사용"으로 켜 주세요.`;
}

const DOCS_DONE: Readonly<Record<DocsLevel, string>> = {
  read: 'Google 문서를 읽기 전용으로 연결했어요.',
  create: 'Google 문서를 연결했어요. 읽기는 모든 문서, 고치기는 ax-kit이 만든 문서만 돼요.',
  edit: 'Google 문서를 연결했어요. 내가 고칠 수 있는 모든 문서를 읽고 고칠 수 있어요 (고칠 때마다 확인 카드).',
};

/** The level this grant supports: "create" without `drive.file` still reads. */
function grantedDocsLevel(wanted: WorkspaceChoice['docs'], granted: (scope: string) => boolean): WorkspaceChoice['docs'] {
  if (wanted === 'edit') return granted(GOOGLE_DOCS_SCOPE) ? 'edit' : 'no';
  if (wanted === 'no' || !granted(GOOGLE_DOCS_READ_SCOPE)) return 'no';
  return wanted === 'create' && !granted(GOOGLE_DRIVE_FILE_SCOPE) ? 'read' : wanted;
}

/**
 * Plugin entries to save after the sign-in: on only where the scope was granted. Other keys the owner wrote are kept.
 * Says what happened in plain Korean.
 */
export function workspaceEntries(
  choice: WorkspaceChoice,
  missingScopes: readonly string[],
  prompter: Prompter,
  existing: Config | undefined,
): Record<string, Record<string, unknown>> {
  const granted = (scope: string): boolean => !missingScopes.includes(scope);
  const docsLevel = grantedDocsLevel(choice.docs, granted);
  const docs = docsLevel !== 'no';
  const sheetsWrite = choice.sheets === 'write' && granted(GOOGLE_SHEETS_SCOPE);
  const sheets = choice.sheets !== 'no' && (sheetsWrite || granted(GOOGLE_SHEETS_READ_SCOPE));
  const tasks = choice.tasks && granted(GOOGLE_TASKS_SCOPE);
  const contacts = choice.contacts && granted(GOOGLE_CONTACTS_READ_SCOPE);
  const keep = (id: string): Record<string, unknown> => ({ ...(existing?.plugins[id] ?? {}) });

  const report = (wanted: boolean, done: boolean, name: string, okText: string): void => {
    if (!wanted) return;
    prompter.say(done ? okText : `${name} 권한을 허용하지 않아 ${name} 연결은 건너뛸게요.`);
  };
  report(choice.docs !== 'no', docs, WORKSPACE_LABELS.docs.name, DOCS_DONE[docsLevel === 'no' ? 'read' : docsLevel]);
  if (choice.docs === 'create' && docsLevel === 'read') {
    prompter.say('새 문서 만들기 권한을 허용하지 않아 Google 문서는 읽기만 돼요.');
  }
  report(choice.sheets !== 'no', sheets, WORKSPACE_LABELS.sheets.name, sheetsWrite ? 'Google 시트를 읽기·쓰기로 연결했어요.' : 'Google 시트를 읽기 전용으로 연결했어요.');
  if (choice.sheets === 'write' && sheets && !sheetsWrite) prompter.say('시트 고치기 권한을 허용하지 않아 Google 시트는 읽기만 돼요.');
  report(choice.tasks, tasks, WORKSPACE_LABELS.tasks.name, 'Google Tasks를 연결했어요. 이제 할 일은 Google Tasks 기본 목록에 저장돼요.');
  report(choice.contacts, contacts, WORKSPACE_LABELS.contacts.name, 'Google 주소록을 읽기 전용으로 연결했어요.');
  if (tasks && !on(existing, WORKSPACE_PLUGIN_IDS.tasks)) {
    prompter.say('이 맥에 있던 할 일은 지워지지 않고 남아 있어요. 다시 쓰려면 설정 plugins["skill.todo"].source를 "local"로 바꾸세요.');
  }

  // A part never chosen and never saved stays out of the config; one saved before is switched to match this grant.
  const entries: Record<string, Record<string, unknown>> = {};
  const put = (id: string, wanted: boolean, entry: Record<string, unknown>): void => {
    if (wanted || existing?.plugins[id] !== undefined) entries[id] = { ...keep(id), ...entry };
  };
  put(WORKSPACE_PLUGIN_IDS.docs, choice.docs !== 'no', docs ? { enabled: true, level: docsLevel } : { enabled: false });
  put(WORKSPACE_PLUGIN_IDS.sheets, choice.sheets !== 'no', { enabled: sheets, write: sheetsWrite });
  put(WORKSPACE_PLUGIN_IDS.tasks, choice.tasks, { enabled: tasks });
  put(WORKSPACE_PLUGIN_IDS.contacts, choice.contacts, { enabled: contacts });
  return entries;
}
