import type { FolderScanner } from './scan.js';
import type { AgentSessionReader } from './sessions.js';

/** What a paired Mac says about itself. */
export interface RemoteInfo {
  /** The other Mac's computer name ("Theo's MacBook Pro"). */
  host: string;
  /** Folders its owner shared, "~/Documents" style. */
  folders: readonly string[];
  /** False when its owner chose not to share Claude Code / Codex sessions. */
  sessions: boolean;
}

/** A file Spotlight found on the other Mac, inside its shared folders. */
export interface RemoteFoundFile {
  name: string;
  /** "MacBook:~/Documents/a.pdf". */
  path: string;
  /** "remote:MacBook:~/Documents/a.pdf". */
  id: string;
  size: number;
  /** ISO 8601. */
  modifiedAt: string;
}

/**
 * Another Mac of the owner's (a work MacBook) running `ax-kit source serve`. Read-only. Every id and path it returns
 * is namespaced "remote:<name>:", so the scanner and session reader can sit next to the local ones.
 */
export interface RemoteSource {
  readonly name: string;
  readonly scanner: FolderScanner;
  readonly sessions: AgentSessionReader;
  info(): Promise<RemoteInfo>;
  find(query: string, limit: number): Promise<readonly RemoteFoundFile[]>;
}

/** Capability "files.remote-sources": the paired Macs, provided by connector.remote-sources. */
export interface RemoteSourceDirectory {
  list(): readonly RemoteSource[];
}
