/**
 * Opt-in Google Workspace scopes. Each is asked for separately in setup (`ax-kit connect google`), like Drive, so an
 * existing connection never reports a scope it was not asked for.
 *
 * - Docs, three levels: "read" (`documents.readonly`: any doc the owner can open, without the much wider
 *   `drive.readonly`), "create" (adds `drive.file`: new docs, and appending only to docs ax-kit made) and "edit"
 *   ("문서 고치기", `documents` instead of `documents.readonly`: append and replace in any doc the owner can edit).
 * - Sheets: read-only and read-write are separate choices, so a read-only owner never grants edit rights.
 * - Tasks: the Tasks API has no narrower write scope than `tasks`.
 * - Contacts: People API read-only.
 */
export const GOOGLE_DOCS_READ_SCOPE = 'https://www.googleapis.com/auth/documents.readonly';
export const GOOGLE_DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';
export const GOOGLE_SHEETS_READ_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const GOOGLE_SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const GOOGLE_TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
export const GOOGLE_CONTACTS_READ_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';

export type WorkspaceFeature = 'docs' | 'sheets' | 'tasks' | 'contacts';

/** How far Docs reaches; saved as plugins["connector.google-docs"].level. A saved entry without one is "create". */
export type DocsLevel = 'read' | 'create' | 'edit';

export function docsLevelOf(entry: Readonly<Record<string, unknown>> | undefined): DocsLevel {
  const level = entry?.['level'];
  return level === 'read' || level === 'edit' ? level : 'create';
}

/** Korean names for the owner, and the API each needs turned on in Google Cloud. */
export const WORKSPACE_LABELS: Readonly<Record<WorkspaceFeature, { name: string; api: string }>> = {
  docs: { name: 'Google 문서(Docs)', api: 'Google Docs API' },
  sheets: { name: 'Google 시트(Sheets)', api: 'Google Sheets API' },
  tasks: { name: 'Google Tasks(할 일)', api: 'Google Tasks API' },
  contacts: { name: 'Google 주소록(Contacts)', api: 'People API' },
};
