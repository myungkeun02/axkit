export interface FileEntry {
  /** Opaque, stable per source: a path for local files, a file id for Drive. */
  id: string;
  name: string;
  /** Human-readable location ("Documents/notes/a.md", "Drive/Plans/b"). */
  path: string;
  mimeType?: string;
  size: number;
  /** ISO 8601. */
  modifiedAt: string;
}

/**
 * Read-only view of folders the owner chose. Providers already drop sensitive names, unsupported types and files over
 * the size cap, so a skill never sees them.
 */
export interface FileSource {
  readonly label: string;
  /** How the owner knows it ("Google Drive · me@example.com"), when the label alone is not enough. */
  readonly title?: string;
  /** Newest first unless `oldestFirst` (the index job walks forward from its cursor that way). */
  list(opts: { modifiedAfter?: Date; limit: number; oldestFirst?: boolean }): Promise<FileEntry[]>;
  readText(id: string, maxBytes: number): Promise<string>;
  /**
   * Recently changed files anywhere the source can see, not only the configured folders (Drive: the owner's own
   * files). Used by the first-run scan; sources without a wider view leave it out.
   */
  recent?(opts: { modifiedAfter?: Date; limit: number }): Promise<FileEntry[]>;
  /**
   * Every file the source can open, a page at a time, newest first (Drive: the account's own files, files shared with
   * it and shared drives). Metadata only; the first look walks it to the end so nothing is sampled.
   */
  everything?(opts: { pageToken?: string; pageSize?: number }): Promise<{ entries: FileEntry[]; next?: string }>;
  /** The stored bytes of a file with no text export (PDF, Word), up to `maxBytes`, for conversion on this Mac. */
  readBytes?(id: string, maxBytes: number): Promise<Uint8Array>;
  /**
   * The file as `list` would show it now; undefined when it is gone or no longer allowed. Throws when that cannot be
   * told (its folder is not reachable right now), so a caller never drops a file it merely could not see.
   */
  entry?(id: string): Promise<FileEntry | undefined>;
  /** Live change tracking over the configured folders. Rejects when no folder could be watched. */
  watch?(listener: (changes: readonly FileChange[]) => void | Promise<void>): Promise<FileWatch>;
}

/**
 * Capability "files.sources", provided by skill.files: where the file index finds its sources. The local folders
 * (`files.local`) and Drive (`files.drive`) are always included; any other connector registers its own source here
 * (from `app.started`, when every plugin has been set up) and the index, search and live tracking pick it up.
 */
export interface FileSourceRegistry {
  /** Adds a source; one with the same label replaces the earlier one. */
  register(source: FileSource): void;
  /** Every connected source, built-in ones first. */
  list(): FileSource[];
}

/** One debounced change: `entry` when the file is there now, absent when the id (a file or a whole folder) is gone. */
export interface FileChange {
  id: string;
  entry?: FileEntry;
}

export interface FileWatch {
  close(): void;
}

export type FileChangeKind = 'added' | 'changed' | 'removed';

/** One line of the change log: `path` is home-relative ("~/Documents/a.md"), `at` ISO 8601. */
export interface FileChangeRecord {
  path: string;
  kind: FileChangeKind;
  at: string;
}

/** Emitted by skill.files after it reindexed changed files, so knowledge and onboarding can react. */
export interface FilesChanged {
  source: string;
  changes: readonly FileChangeRecord[];
}

declare module '../events/types.js' {
  interface EventMap {
    'files.changed': FilesChanged;
  }
}

/** Why the app could not take a file in; skills turn it into the owner's language. */
export type AppShareFailure = 'type' | 'size' | 'not-file' | 'unreadable' | 'mismatch';

export class AppShareError extends Error {
  override readonly name = 'AppShareError';
  constructor(
    readonly reason: AppShareFailure,
    message: string,
  ) {
    super(message);
  }
}

/** Capability "app.share-file", provided by channel.app: a file sent to the owner's own app as a chat attachment. */
export interface AppFileShare {
  /** Copies the file in and posts `text` with it. Throws `AppShareError` when the file cannot be sent. */
  send(file: { path: string; name?: string; text: string }): Promise<{ id: string; name: string; contentType: string; size: number }>;
}
