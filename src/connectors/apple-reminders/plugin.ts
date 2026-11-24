import { homedir } from 'node:os';
import { join } from 'node:path';
import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import type { ProcessRunner } from '../../core/process/types.js';
import { AppleReminders } from './backend.js';
import type { RemindersClient } from './client.js';
import { HelperRemindersClient, remindersHelperPath } from './client.js';

export interface AppleRemindersConnectorOptions {
  /** Where the compiled helper is cached; defaults to ~/.ax-kit/bin. */
  binDir?: string;
  run?: ProcessRunner;
  client?: RemindersClient;
}

export interface RemindersCheck {
  id: 'reminders.access';
  ok: boolean;
  detail: string;
  fix?: string;
}

const SETTINGS_FIX =
  'System Settings > Privacy & Security > Reminders: allow the app that runs ax-kit (Terminal or node), then restart ax-kit';

export function remindersClient(options: AppleRemindersConnectorOptions = {}): RemindersClient {
  if (options.client !== undefined) return options.client;
  const run = options.run ?? nodeProcessRunner;
  const binDir = options.binDir ?? join(homedir(), '.ax-kit', 'bin');
  return new HelperRemindersClient({ run, helperPath: remindersHelperPath(binDir, run) });
}

/** Doctor check: reads the permission state only. It never shows the prompt and never reads a reminder. */
export async function remindersCheck(client: RemindersClient): Promise<RemindersCheck> {
  try {
    const status = await client.status();
    if (status === 'authorized') return { id: 'reminders.access', ok: true, detail: 'Reminders access is allowed.' };
    if (status === 'not-determined') {
      return {
        id: 'reminders.access',
        ok: false,
        detail: 'Reminders access was not asked yet.',
        fix: 'start ax-kit and allow Reminders when macOS asks on the first sync',
      };
    }
    return { id: 'reminders.access', ok: false, detail: `Reminders access is ${status}.`, fix: SETTINGS_FIX };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { id: 'reminders.access', ok: false, detail, fix: 'xcode-select --install (swiftc builds the helper)' };
  }
}

/**
 * Apple Reminders as the to-do skill's two-way sync partner (`todo.sync`), opt-in. Config:
 * plugins["connector.apple-reminders"].list = the list title (default: the list for new reminders).
 */
export function appleRemindersConnector(options: AppleRemindersConnectorOptions = {}): Plugin {
  return {
    manifest: { id: 'connector.apple-reminders', kind: 'connector', title: 'Apple Reminders (to-do sync)' },
    setup(ctx) {
      const listName = typeof ctx.config['list'] === 'string' ? ctx.config['list'] : undefined;
      const backend = new AppleReminders(remindersClient(options), listName !== undefined ? { listName } : {});
      ctx.provide(Contracts.todoSync, backend);
    },
  };
}
