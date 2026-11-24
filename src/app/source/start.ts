import type { Server } from 'node:http';
import { homedir, hostname } from 'node:os';
import { DEFAULT_FILE_RULES } from '../../core/files/filter.js';
import type { Logger } from '../../core/log/types.js';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import type { ProcessRunner } from '../../core/process/types.js';
import { nodeSessionFs } from '../../connectors/agent-sessions/fs.js';
import { LocalAgentSessionReader } from '../../connectors/agent-sessions/reader.js';
import type { LocalFs } from '../../connectors/local-files/fs.js';
import { nodeLocalFs } from '../../connectors/local-files/fs.js';
import type { SourceConfig } from './config.js';
import { SourceOps } from './ops.js';
import { listenSource, sourceHandler } from './server.js';
import { SourceTokens } from './tokens.js';

export interface StartSourceOptions {
  config: SourceConfig;
  sourceHome: string;
  /** Addresses to listen on: 127.0.0.1 and this Mac's Tailscale address. */
  hosts: readonly string[];
  log: Logger;
  /** Tests: port 0 picks a free one; fixed homes and file systems. */
  port?: number;
  home?: string;
  fs?: LocalFs;
  run?: ProcessRunner;
  host?: string;
  perMinute?: number;
}

export interface RunningSource {
  servers: Server[];
  /** Adds an address later (Tailscale came up after start). */
  listen(host: string): Promise<void>;
  close(): Promise<void>;
}

/** "Theos-MacBook-Pro.local" → "Theos-MacBook-Pro". */
export function computerName(): string {
  return hostname().replace(/\.local$/i, '');
}

/** `ax-kit source serve`: the read-only API over the shared folders and (if allowed) the coding sessions. */
export async function startSourceServer(options: StartSourceOptions): Promise<RunningSource> {
  const home = options.home ?? homedir();
  const ops = new SourceOps({
    fs: options.fs ?? nodeLocalFs,
    run: options.run ?? nodeProcessRunner,
    rules: DEFAULT_FILE_RULES,
    home,
    folders: options.config.folders,
    ...(options.config.sessions ? { sessions: new LocalAgentSessionReader({ fs: nodeSessionFs, home }) } : {}),
    log: options.log,
  });
  const handler = sourceHandler({
    ops,
    tokens: new SourceTokens({ dir: options.sourceHome }),
    host: options.host ?? computerName(),
    log: options.log,
    ...(options.perMinute !== undefined ? { perMinute: options.perMinute } : {}),
  });
  const port = options.port ?? options.config.port;
  const servers = await listenSource(handler, options.hosts, port);
  return {
    servers,
    async listen(host) {
      servers.push(...(await listenSource(handler, [host], port)));
    },
    async close() {
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    },
  };
}
