import { Contracts } from '../../core/contracts/index.js';
import type { Plugin, PluginContext } from '../../core/plugin/types.js';
import { GoogleContacts } from './contacts.js';
import { GoogleDocs } from './docs.js';
import { googleRequest } from './http.js';
import type { GoogleRequestFn } from './http.js';
import { withAccessHelp } from './scope-help.js';
import type { AccessTexts } from './scope-help.js';
import { GoogleSheets } from './sheets.js';
import { GoogleTasks } from './tasks.js';
import { GoogleTokenSource, OAUTH_CLIENT_SECRET, REFRESH_TOKEN_SECRET } from './token.js';
import type { DocsLevel, WorkspaceFeature } from './workspace-scopes.js';
import { docsLevelOf } from './workspace-scopes.js';

export interface GoogleWorkspaceOptions {
  /** Tests inject a fake; production uses global fetch. */
  fetch?: typeof fetch;
  /** Tests inject a fake; production waits real milliseconds. */
  sleep?: (ms: number) => Promise<void>;
}

const SECRETS = [OAUTH_CLIENT_SECRET, REFRESH_TOKEN_SECRET] as const;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function requestFor(ctx: PluginContext, opts: GoogleWorkspaceOptions, feature: WorkspaceFeature, texts?: AccessTexts): GoogleRequestFn {
  const fetchImpl = opts.fetch ?? fetch;
  const tokens = new GoogleTokenSource({ secrets: ctx.secrets, clock: ctx.clock, fetch: fetchImpl });
  const sleep = opts.sleep ?? defaultSleep;
  const request: GoogleRequestFn = <T>(url: string, init?: RequestInit): Promise<T> =>
    googleRequest<T>({ fetch: fetchImpl, tokens, sleep }, url, init);
  return withAccessHelp(request, feature, texts);
}

function connector(id: string, title: string, setup: (ctx: PluginContext) => void): Plugin {
  return { manifest: { id, kind: 'connector', title, secrets: [...SECRETS] }, setup };
}

const DOC_NOT_FOUND = '그 문서를 찾지 못했어요. 문서 주소나 id를 확인해 주세요.';
/** How to reach the "edit" level, added wherever a lower level stops the owner. */
export const DOCS_EDIT_HOW =
  '내가 고칠 수 있는 모든 문서를 고치려면 맥에서 `ax-kit setup` → "꺼진 것만 이어서 설정" → "문서 고치기"를 켜 주세요 (또는 `ax-kit connect google`).';

function docsWriteTexts(level: DocsLevel): AccessTexts {
  if (level === 'edit') {
    return { notFound: DOC_NOT_FOUND, denied: '이 문서는 고칠 권한이 없어요. 편집자로 공유받은 문서인지 확인해 주세요.' };
  }
  return {
    notFound: `${DOC_NOT_FOUND} 지금은 ax-kit이 직접 만든 문서에만 글을 덧붙일 수 있어요. ${DOCS_EDIT_HOW}`,
    denied: `이 문서는 고칠 수 없어요. 지금은 ax-kit이 직접 만든 문서에만 글을 덧붙일 수 있어요. 새 문서로 만들까요? ${DOCS_EDIT_HOW}`,
  };
}

/**
 * Google Docs. plugins["connector.google-docs"].level: "read" (reads only), "create" (default: new docs, and
 * appending to docs ax-kit made) or "edit" ("문서 고치기": append and replace in any doc the owner can edit).
 */
export function googleDocsConnector(opts: GoogleWorkspaceOptions = {}): Plugin {
  return connector('connector.google-docs', 'Google Docs', (ctx) => {
    const level = docsLevelOf(ctx.config);
    const reader = new GoogleDocs(
      requestFor(ctx, opts, 'docs', { notFound: DOC_NOT_FOUND, denied: '이 문서를 볼 권한이 없어요. 내 계정에 공유된 문서인지 확인해 주세요.' }),
    );
    ctx.provide(Contracts.docsRead, reader);
    if (level === 'read') return;
    const writer = new GoogleDocs(requestFor(ctx, opts, 'docs', docsWriteTexts(level)));
    ctx.provide(Contracts.docsWrite, writer);
    if (level === 'edit') ctx.provide(Contracts.docsEdit, writer);
  });
}

/** Google Sheets. `write: true` in the plugin config (setup sets it with the read-write scope) adds edits. */
export function googleSheetsConnector(opts: GoogleWorkspaceOptions = {}): Plugin {
  return connector('connector.google-sheets', 'Google Sheets', (ctx) => {
    const sheets = new GoogleSheets(
      requestFor(ctx, opts, 'sheets', {
        notFound: '그 시트나 범위를 찾지 못했어요. 시트 주소와 탭 이름을 확인해 주세요.',
        denied: '이 시트에 접근할 권한이 없어요. 공유받은 시트인지, 고치기 권한이 있는지 확인해 주세요.',
      }),
    );
    ctx.provide(Contracts.sheetsRead, sheets);
    if (ctx.config['write'] === true) ctx.provide(Contracts.sheetsWrite, sheets);
  });
}

/** Google Tasks (default list) as the to-do skill's backend. */
export function googleTasksConnector(opts: GoogleWorkspaceOptions = {}): Plugin {
  return connector('connector.google-tasks', 'Google Tasks', (ctx) => {
    const tasks = new GoogleTasks(
      requestFor(ctx, opts, 'tasks', { notFound: 'Google Tasks에서 그 할 일을 찾지 못했어요. 이미 지워졌을 수 있어요.' }),
      () => ctx.clock.now(),
    );
    ctx.provide(Contracts.todoBackend, tasks);
  });
}

/** Google Contacts, read-only. */
export function googleContactsConnector(opts: GoogleWorkspaceOptions = {}): Plugin {
  return connector('connector.google-contacts', 'Google Contacts', (ctx) => {
    ctx.provide(Contracts.contactsRead, new GoogleContacts(requestFor(ctx, opts, 'contacts')));
  });
}
