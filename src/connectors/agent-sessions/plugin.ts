import { homedir } from 'node:os';
import { Contracts } from '../../core/contracts/index.js';
import { composeSessionReader } from '../../core/remote/compose.js';
import type { Plugin } from '../../core/plugin/types.js';
import type { SessionFs } from './fs.js';
import { nodeSessionFs } from './fs.js';
import { LocalAgentSessionReader } from './reader.js';

export interface AgentSessionsConnectorOptions {
  /** Tests inject their own reads; production uses node:fs. */
  fs?: SessionFs;
  /** Test override for the folder holding `.claude` and `.codex`. */
  home?: string;
}

/** Connector for the first look at past Claude Code and Codex sessions. Read-only. */
export function agentSessionsConnector(opts: AgentSessionsConnectorOptions = {}): Plugin {
  return {
    manifest: {
      id: 'connector.agent-sessions',
      kind: 'connector',
      title: 'Coding sessions (Claude Code, Codex)',
    },
    setup(ctx) {
      const local = new LocalAgentSessionReader({ fs: opts.fs ?? nodeSessionFs, home: opts.home ?? homedir() });
      // Sessions on paired Macs (connector.remote-sources) join at run time.
      ctx.provide(Contracts.agentSessions, composeSessionReader(local, () => ctx.tryUse(Contracts.remoteSources)?.list() ?? [], ctx.log));
    },
  };
}
