import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import type { RemoteFoundFile, RemoteSource } from '../../core/contracts/remote.js';
import type { Plugin } from '../../core/plugin/types.js';
import { remoteTokenSecret } from '../../core/remote/ids.js';
import type { Tool } from '../../core/tools/types.js';
import type { PostJson } from './http.js';
import { HttpRemoteSource } from './source.js';
import type { PairedRemote } from './store.js';

export interface RemoteSourcesConnectorOptions {
  /** The paired Macs from `<home>/remotes.json`; their tokens are read from the Keychain. */
  remotes: readonly PairedRemote[];
  /** Tests point it at a local test server. */
  post?: PostJson;
}

const findInput = z.object({
  query: z.string().trim().min(1).max(200).describe('A file name or part of one.'),
  mac: z.string().trim().max(40).optional().describe('Only this paired Mac (its name); all of them when left out.'),
  limit: z.number().int().min(1).max(20).default(10),
});

type FindInput = z.infer<typeof findInput>;

function findTool(sources: readonly RemoteSource[]): Tool<FindInput, { found: RemoteFoundFile[]; unreachable: string[] }> {
  return {
    name: 'files.find_remote',
    description:
      'Find files by name on the owner\'s other Macs (a work MacBook paired with `ax-kit source pair`), inside the folders shared there. Returns names, "MacBook:~/…" paths, sizes and dates only.',
    input: findInput,
    effects: ['read'],
    async run(input) {
      const wanted = input.mac?.toLowerCase();
      const targets = sources.filter((source) => wanted === undefined || wanted === '' || source.name.toLowerCase() === wanted);
      const unreachable: string[] = [];
      const results = await Promise.all(
        targets.map((source) =>
          source.find(input.query, input.limit).catch(() => {
            unreachable.push(source.name);
            return [];
          }),
        ),
      );
      return { found: results.flat().slice(0, input.limit), unreachable };
    },
  };
}

/**
 * Connector for the owner's other Macs: each paired one gives a read-only folder scanner, its Claude Code / Codex
 * sessions and Spotlight search by name, all over Tailscale. connector.folder-scan and connector.agent-sessions
 * fold them in next to this Mac's own.
 */
export function remoteSourcesConnector(opts: RemoteSourcesConnectorOptions): Plugin {
  return {
    manifest: {
      id: 'connector.remote-sources',
      kind: 'connector',
      title: 'Other Macs (read-only)',
      secrets: opts.remotes.map((remote) => remoteTokenSecret(remote.name)),
    },
    setup(ctx) {
      const sources: RemoteSource[] = opts.remotes.map(
        (remote) =>
          new HttpRemoteSource({
            name: remote.name,
            url: remote.url,
            token: () => ctx.secrets.get(remoteTokenSecret(remote.name)),
            ...(opts.post !== undefined ? { post: opts.post } : {}),
          }),
      );
      ctx.provide(Contracts.remoteSources, { list: () => sources });
      if (sources.length > 0) ctx.registerTool(findTool(sources));
    },
  };
}
