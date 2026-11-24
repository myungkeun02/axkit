import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import type { ProcessRunner } from '../../core/process/types.js';
import type { Plugin } from '../../core/plugin/types.js';
import { AsideWebAgent } from './agent.js';

const configSchema = z.object({
  command: z.string().min(1).max(300).optional(),
  account: z.string().regex(/^u\d+(:[\w-]+)?$/).optional(),
  effort: z.enum(['low', 'medium', 'high']).optional(),
  timeoutMinutes: z.number().int().min(1).max(30).default(10),
});

const CANDIDATES = [join(homedir(), '.local', 'bin', 'aside'), '/opt/homebrew/bin/aside', '/usr/local/bin/aside'];

export async function findAside(extra?: string): Promise<string | undefined> {
  for (const path of [...(extra !== undefined ? [extra] : []), ...CANDIDATES]) {
    if (await access(path).then(() => true, () => false)) return path;
  }
  return undefined;
}

/** Provides `web.agent` when the Aside CLI is installed and signed in on this Mac; silent otherwise. */
export function asideConnector(options: { run?: ProcessRunner; command?: string } = {}): Plugin {
  return {
    manifest: { id: 'connector.aside', kind: 'connector', title: 'Aside browser (owner signed-in web)' },
    async setup(ctx) {
      const parsed = configSchema.safeParse(ctx.config);
      const config = parsed.success ? parsed.data : { timeoutMinutes: 10 };
      const command = options.command ?? (await findAside(config.command));
      if (command === undefined) {
        ctx.log.info('aside: CLI not found, the web agent is off');
        return;
      }
      ctx.provide(
        Contracts.webAgent,
        new AsideWebAgent({
          command,
          run: options.run ?? nodeProcessRunner,
          defaultTimeoutMinutes: config.timeoutMinutes,
          ...(config.account !== undefined ? { account: config.account } : {}),
          ...(config.effort !== undefined ? { effort: config.effort } : {}),
        }),
      );
    },
  };
}
