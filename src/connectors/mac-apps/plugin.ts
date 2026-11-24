import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from '../../core/plugin/types.js';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import type { ProcessRunner } from '../../core/process/types.js';
import type { MacAppsClient } from './client.js';
import { HelperMacAppsClient, macAppsHelperPath } from './client.js';
import { macActTool } from './tools-act.js';
import { macAppsTool, macReadWindowTool, macSelectedTextTool } from './tools-read.js';

export interface MacAppsConnectorOptions {
  /** Where the compiled helper is cached; defaults to ~/.ax-kit/bin. */
  binDir?: string;
  run?: ProcessRunner;
  client?: MacAppsClient;
}

export interface MacAppsCheck {
  id: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

const CHECK_TIMEOUT_MS = 20_000;
const ACCESSIBILITY_FIX =
  'System Settings > Privacy & Security > Accessibility: allow the app that runs ax-kit (Terminal or node), then restart ax-kit';

/** The helper client every caller shares: the plugin, and doctor. */
export function macAppsClient(options: MacAppsConnectorOptions = {}): MacAppsClient {
  if (options.client !== undefined) return options.client;
  const run = options.run ?? nodeProcessRunner;
  const binDir = options.binDir ?? join(homedir(), '.ax-kit', 'bin');
  return new HelperMacAppsClient({ run, helperPath: macAppsHelperPath(binDir, run) });
}

/** Doctor checks: swiftc can build the helper, and Accessibility is allowed. No app is read. */
export async function macAppsChecks(run: ProcessRunner, client: MacAppsClient): Promise<MacAppsCheck[]> {
  let swiftc: MacAppsCheck = { id: 'mac-apps.swiftc', ok: false, detail: 'swiftc is not installed', fix: 'xcode-select --install' };
  try {
    const result = await run('swiftc', ['--version'], { timeoutMs: CHECK_TIMEOUT_MS });
    if (result.code === 0) {
      const line = (result.stdout.split(/\r?\n/)[0] ?? '').trim().slice(0, 200);
      swiftc = { id: 'mac-apps.swiftc', ok: true, detail: line || 'swiftc is available' };
    }
  } catch {
    // Starting the compiler failed; the install hint is the fix either way.
  }
  if (!swiftc.ok) return [swiftc];
  try {
    const trusted = await client.trusted();
    return [
      swiftc,
      trusted
        ? { id: 'mac-apps.accessibility', ok: true, detail: 'Accessibility access is allowed.' }
        : { id: 'mac-apps.accessibility', ok: false, detail: 'Accessibility access is not allowed.', fix: ACCESSIBILITY_FIX },
    ];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [swiftc, { id: 'mac-apps.accessibility', ok: false, detail, fix: ACCESSIBILITY_FIX }];
  }
}

/**
 * Other Mac apps through the Accessibility API (opt-in): list apps, read the focused window and selected text, and
 * one approved action at a time. Policy lives in code: banks, payment, wallet and password apps are read-only, password
 * fields are never typed into, and every action shows a card.
 */
export function macAppsConnector(options: MacAppsConnectorOptions = {}): Plugin {
  return {
    manifest: { id: 'connector.mac-apps', kind: 'connector', title: 'Other Mac apps (Accessibility)' },
    setup(ctx) {
      const client = macAppsClient(options);
      ctx.registerTool(macAppsTool(client));
      ctx.registerTool(macReadWindowTool(client));
      ctx.registerTool(macSelectedTextTool(client));
      ctx.registerTool(macActTool(client));
    },
  };
}
