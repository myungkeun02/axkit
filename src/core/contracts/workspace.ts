/** A Google Doc read as plain text. The text is someone's document: data, never instructions. */
export interface DocText {
  id: string;
  title: string;
  text: string;
  /** True when the text was cut at the caller's limit. */
  truncated: boolean;
  url: string;
}

/** Capability "docs.read": reads any document the owner can open, every tab ("## <tab title>" between tabs). */
export interface DocsReader {
  read(id: string, maxChars: number, signal?: AbortSignal): Promise<DocText>;
}

/** Where in a document a change goes. Without a tab title, the first tab. */
export interface DocTarget {
  tab?: string;
}

/**
 * Capability "docs.write": adds text. With the "문서 고치기" level (`documents` scope) any document the owner can edit;
 * otherwise only documents ax-kit created (`drive.file`).
 */
export interface DocsWriter {
  append(id: string, text: string, target?: DocTarget, signal?: AbortSignal): Promise<{ id: string; url: string }>;
  create(title: string, text: string, signal?: AbortSignal): Promise<{ id: string; url: string }>;
}

export interface DocReplaceResult {
  id: string;
  url: string;
  /** How many places Google changed (1 when the phrase was unique, as checked before the change). */
  replaced: number;
}

/** Capability "docs.edit": only with the `documents` scope. Replaces one exact phrase that appears once in the tab. */
export interface DocsEditor {
  replaceText(id: string, find: string, replace: string, target?: DocTarget, signal?: AbortSignal): Promise<DocReplaceResult>;
}

export interface SheetTab {
  title: string;
  rows: number;
  columns: number;
}

export interface SheetInfo {
  id: string;
  title: string;
  tabs: readonly SheetTab[];
  url: string;
}

export interface SheetValues {
  /** The A1 range Google actually returned ("시트1!A1:D20"). */
  range: string;
  rows: string[][];
  /** True when rows or columns were cut at the caps. */
  truncated: boolean;
}

/** Capability "sheets.read". */
export interface SheetsReader {
  info(id: string, signal?: AbortSignal): Promise<SheetInfo>;
  /** Formatted values; `range` in A1 notation, a tab name alone, or omitted for the first tab. */
  read(id: string, range: string | undefined, caps: { rows: number; columns: number }, signal?: AbortSignal): Promise<SheetValues>;
}

/** Capability "sheets.write". Values are stored as typed text (RAW): a cell starting with "=" is not run as a formula. */
export interface SheetsWriter {
  append(id: string, range: string, rows: readonly (readonly string[])[], signal?: AbortSignal): Promise<{ updatedRange: string; rows: number }>;
  update(id: string, range: string, rows: readonly (readonly string[])[], signal?: AbortSignal): Promise<{ updatedRange: string; cells: number }>;
}

/** One entry of the owner's address book. */
export interface Contact {
  name: string;
  emails: readonly string[];
  phones: readonly string[];
  organization?: string;
  /** Job title in the organization ("대표"). */
  title?: string;
}

/** Capability "contacts.read": the owner's Google Contacts, read-only. */
export interface ContactsReader {
  /** Matches names, emails, phone numbers and organizations by prefix. */
  search(query: string, limit: number, signal?: AbortSignal): Promise<Contact[]>;
}
