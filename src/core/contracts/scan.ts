/** One file seen during a folder scan. Sensitive names are never listed. */
export interface ScannedFile {
  /** Real absolute path; pass it back to `excerpt`. */
  id: string;
  /** "~/Documents/plans/a.md" style, for citations. */
  path: string;
  name: string;
  /** Lower-case extension without the dot, "" when none. */
  ext: string;
  size: number;
  /** ISO 8601. */
  modifiedAt: string;
  /** True when the type and size allow reading an excerpt. */
  readable: boolean;
}

export interface ScannedRepo {
  /** Real absolute path of the working tree. */
  id: string;
  path: string;
  name: string;
  /** ISO 8601 of the newest file or commit seen. */
  modifiedAt: string;
}

export interface RepoCommit {
  /** ISO 8601. */
  at: string;
  /** First line of the message, secrets masked. */
  subject: string;
}

export interface RepoDetails {
  readme?: string;
  commits: readonly RepoCommit[];
  /** File counts by extension, largest first. */
  languages: readonly { ext: string; files: number }[];
}

export interface FolderWalk {
  files: readonly ScannedFile[];
  /** Git working trees found; their contents are not listed as files. */
  repos: readonly ScannedRepo[];
  /** True when a cap stopped the walk early. */
  truncated: boolean;
}

/** A scan over a fixed set of folders the owner chose. Read-only; symlinks are never followed. */
export interface FolderScan {
  walk(signal?: AbortSignal): Promise<FolderWalk>;
  /** Text excerpt of a readable file inside the folders. */
  excerpt(id: string, maxBytes: number): Promise<string>;
  repo(id: string): Promise<RepoDetails>;
  /**
   * Plain text of a word-processor file inside the folders (doc, docx, rtf, odt…), converted on this Mac without
   * uploading it. Undefined when the format has no converter here (PDF goes through "ocr.text").
   */
  documentText?(id: string, maxChars: number): Promise<string | undefined>;
  /** Text documents git tracks in a repository inside the folders (README, docs/…), sensitive names left out. */
  repoDocs?(id: string, max: number): Promise<readonly ScannedFile[]>;
}

/** The git working tree a folder belongs to. */
export interface RepoRoot {
  /** Real absolute path of the working tree. */
  root: string;
  /** "~/dev/app" style. */
  display: string;
  name: string;
  /** "github.com/owner/repo" style origin, credentials removed. */
  remote?: string;
}

/** Capability "files.scan": opens a scan over the folders the owner picked in setup. */
export interface FolderScanner {
  open(folders: readonly string[]): FolderScan;
  /**
   * The nearest git working tree that holds `path` (itself or a parent), read from `.git` without running git.
   * Undefined when the folder is gone or in no repository. Used to tie coding sessions to projects.
   */
  locate?(path: string): Promise<RepoRoot | undefined>;
}
