import { homedir } from 'node:os';
import { join } from 'node:path';
import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import type { ProcessRunner } from '../../core/process/types.js';
import { CliBrowserAgent } from './cli-agent.js';
import { readBrowserConfig } from './config.js';
import { PlaywrightAgent } from './playwright-agent.js';
import type { PlaywrightLike } from './playwright-agent.js';

export interface BrowserConnectorOptions {
  profileDir?: string;
  run?: ProcessRunner;
  loadPlaywright?: () => Promise<PlaywrightLike>;
}

/**
 * A browser the owner set up on this Mac. Playwright is the default; a browser-agent CLI is the other adapter.
 * The profile is persistent and is created lazily on the first run, never during setup.
 */
export function browserConnector(options: BrowserConnectorOptions = {}): Plugin {
  return {
    manifest: {
      id: 'connector.browser',
      kind: 'connector',
      title: 'Browser on this Mac (Playwright or a browser agent CLI)',
    },
    setup(ctx) {
      const config = readBrowserConfig(ctx.config, ctx.log);
      if (config.adapter === 'cli') {
        ctx.provide(
          Contracts.browser,
          new CliBrowserAgent({
            run: options.run ?? nodeProcessRunner,
            command: config.cli.command,
            args: config.cli.args,
            timeoutMs: config.cli.timeoutSeconds * 1000,
            label: config.cli.command,
          }),
        );
        return;
      }
      ctx.provide(
        Contracts.browser,
        new PlaywrightAgent({
          profileDir: options.profileDir ?? join(homedir(), '.ax-kit', 'browser-profile'),
          headless: config.headless,
          readTimeoutMs: config.readTimeoutSeconds * 1000,
          // multi-step errands go through the harness with the owner's own model routes
          llm: ctx.llm,
          runsDir: join(options.profileDir ?? join(homedir(), '.ax-kit', 'browser-profile'), '..', 'browser-runs'),
          ...(options.loadPlaywright !== undefined ? { load: options.loadPlaywright } : {}),
        }),
      );
    },
  };
}
