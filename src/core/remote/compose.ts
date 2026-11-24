import type { RemoteSource } from '../contracts/remote.js';
import type { FolderScan, FolderScanner, FolderWalk, RepoDetails, RepoRoot, ScannedFile } from '../contracts/scan.js';
import type { AgentSession, AgentSessionReader } from '../contracts/sessions.js';
import type { Logger } from '../log/types.js';
import { parseRemote } from './ids.js';

const EMPTY_WALK: FolderWalk = { files: [], repos: [], truncated: false };
const MAX_SESSIONS = 5_000;

export type RemoteList = () => readonly RemoteSource[];

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

function findRemote(remotes: RemoteList, value: string): RemoteSource | undefined {
  const parsed = parseRemote(value);
  if (parsed === undefined) return undefined;
  const lower = parsed.name.toLowerCase();
  return remotes().find((remote) => remote.name.toLowerCase() === lower);
}

/** Folder specs split per Mac: plain paths stay here, "remote:<name>[:<path>]" go to that Mac. */
function splitFolders(folders: readonly string[], remotes: readonly RemoteSource[]): { local: string[]; remote: Map<RemoteSource, string[]> } {
  const local: string[] = [];
  const remote = new Map<RemoteSource, string[]>();
  for (const folder of folders) {
    const parsed = parseRemote(folder);
    if (parsed === undefined) {
      if (!folder.startsWith('remote:')) local.push(folder);
      continue;
    }
    const source = remotes.find((candidate) => candidate.name.toLowerCase() === parsed.name.toLowerCase());
    if (source === undefined) continue;
    remote.set(source, [...(remote.get(source) ?? []), folder]);
  }
  return { local, remote };
}

/**
 * The folder scanner the first look and project discovery use: this Mac's folders plus every paired Mac's shared
 * folders. A Mac that cannot be reached (asleep, off Tailscale) is skipped and logged, never fatal.
 */
export function composeFolderScanner(local: FolderScanner, remotes: RemoteList, log: Logger): FolderScanner {
  return {
    open(folders: readonly string[]): FolderScan {
      const listed = remotes();
      if (listed.length === 0) return local.open(folders);
      const split = splitFolders(folders, listed);
      const here = local.open(split.local);
      const there = new Map<RemoteSource, FolderScan>([...split.remote].map(([source, specs]) => [source, source.scanner.open(specs)]));
      const route = (id: string): FolderScan => {
        const source = findRemote(remotes, id);
        if (source === undefined) {
          if (id.startsWith('remote:')) throw new Error('The Mac this file is on is not paired.');
          return here;
        }
        return there.get(source) ?? source.scanner.open([]);
      };
      return {
        walk: async (signal): Promise<FolderWalk> => {
          const walks = await Promise.all([
            split.local.length > 0 ? here.walk(signal) : Promise.resolve(EMPTY_WALK),
            ...[...there].map(([source, scan]) =>
              scan.walk(signal).catch((error: unknown) => {
                log.warn('remote-sources: a Mac could not be scanned', { remote: source.name, error: errorName(error) });
                return EMPTY_WALK;
              }),
            ),
          ]);
          return {
            files: walks.flatMap((walk) => walk.files),
            repos: walks.flatMap((walk) => walk.repos),
            truncated: walks.some((walk) => walk.truncated),
          };
        },
        excerpt: async (id, maxBytes) => await route(id).excerpt(id, maxBytes),
        repo: async (id): Promise<RepoDetails> => await route(id).repo(id),
        documentText: async (id, maxChars) => await route(id).documentText?.(id, maxChars),
        repoDocs: async (id, max): Promise<readonly ScannedFile[]> => (await route(id).repoDocs?.(id, max)) ?? [],
      };
    },
    async locate(path: string): Promise<RepoRoot | undefined> {
      const source = findRemote(remotes, path);
      if (source === undefined) return path.startsWith('remote:') ? undefined : await local.locate?.(path);
      return await source.scanner.locate?.(path).catch(() => undefined);
    },
  };
}

function byNewest(a: AgentSession, b: AgentSession): number {
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

/** Sessions on this Mac and on every paired Mac, newest first. An unreachable Mac counts as no sessions. */
export function composeSessionReader(local: AgentSessionReader, remotes: RemoteList, log: Logger): AgentSessionReader {
  return {
    async list(signal?: AbortSignal): Promise<readonly AgentSession[]> {
      const listed = remotes();
      if (listed.length === 0) return await local.list(signal);
      const all = await Promise.all([
        local.list(signal),
        ...listed.map((source) =>
          source.sessions.list(signal).catch((error: unknown) => {
            log.warn('remote-sources: sessions could not be listed', { remote: source.name, error: errorName(error) });
            return [];
          }),
        ),
      ]);
      return all.flat().sort(byNewest).slice(0, MAX_SESSIONS);
    },
    async transcript(session, maxChars): Promise<string | undefined> {
      const source = findRemote(remotes, session.id);
      if (source === undefined) return session.id.startsWith('remote:') ? undefined : await local.transcript(session, maxChars);
      return await source.sessions.transcript(session, maxChars);
    },
  };
}
