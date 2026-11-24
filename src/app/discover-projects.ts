import { homedir } from 'node:os';
import { nodeSessionFs } from '../connectors/agent-sessions/fs.js';
import { LocalAgentSessionReader } from '../connectors/agent-sessions/reader.js';
import { readLocalFilesSettings } from '../connectors/local-files/config.js';
import { nodeLocalFs } from '../connectors/local-files/fs.js';
import { LocalFolderScanner } from '../connectors/local-files/scanner.js';
import { silentLogger } from '../core/log/console-logger.js';
import { nodeProcessRunner } from '../core/process/node-runner.js';
import type { RemoteSource } from '../core/contracts/remote.js';
import { composeFolderScanner, composeSessionReader } from '../core/remote/compose.js';
import type { ProjectCandidate } from '../skills/onboarding/projects.js';
import { discoverProjects } from '../skills/onboarding/projects.js';

/**
 * The projects in these folders and in this computer's Claude Code / Codex sessions, for `ax-kit setup` before the
 * server runs. Read-only: lists folders, reads `.git/config` and session files, never changes anything.
 */
export async function discoverOnThisComputer(
  folders: readonly string[],
  opts: { home?: string; korean?: boolean; remotes?: readonly RemoteSource[] } = {},
): Promise<ProjectCandidate[]> {
  const home = opts.home ?? homedir();
  const { rules } = readLocalFilesSettings({}, silentLogger);
  // Folders and sessions on paired Macs ("remote:MacBook[:~/x]") come along when remotes are given.
  const remotes = (): readonly RemoteSource[] => opts.remotes ?? [];
  const scanner = composeFolderScanner(new LocalFolderScanner({ fs: nodeLocalFs, run: nodeProcessRunner, rules, home, log: silentLogger }), remotes, silentLogger);
  const sessions = composeSessionReader(new LocalAgentSessionReader({ fs: nodeSessionFs, home }), remotes, silentLogger);
  const [walk, list] = await Promise.all([
    folders.length > 0 ? scanner.open(folders).walk() : Promise.resolve({ files: [], repos: [], truncated: false }),
    sessions.list().catch(() => []),
  ]);
  let realHome = home;
  try {
    realHome = await nodeLocalFs.realpath(home);
  } catch {
    // Keep the configured home.
  }
  return await discoverProjects({
    repos: walk.repos,
    files: walk.files,
    sessions: list,
    locate: async (path) => await scanner.locate?.(path),
    home: realHome,
    personal: opts.korean === false ? 'Personal' : '개인',
  });
}
