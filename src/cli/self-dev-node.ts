import { homedir } from 'node:os';
import { detectApps } from '../skills/self-dev/apps.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeProcessRunner } from '../core/process/node-runner.js';
import { resolveCommand } from '../core/process/resolve-command.js';
import { ClaudeCliCoder, CodexCliCoder } from '../skills/dev-assist/coder.js';
import { DEFAULT_CHECKS } from '../skills/self-dev/job.js';
import type { SelfDevOptions } from '../skills/self-dev/plugin.js';
import { LAUNCHD_LABEL } from './service.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CODER_TIMEOUT_MS = 25 * 60_000;

/** The real Mac for the "ax 개선" room: this checkout, Claude Code (or Codex) in a worktree, the repo's own checks. */
export function selfDevOptions(home: string): SelfDevOptions {
  const pnpm = resolveCommand('pnpm') ?? 'pnpm';
  const checks = DEFAULT_CHECKS.map(([cmd, ...args]) => [cmd === 'pnpm' ? pnpm : (cmd ?? ''), ...args]);
  return {
    root: ROOT,
    workDir: join(home, 'self-dev'),
    managed: process.env['XPC_SERVICE_NAME'] === LAUNCHD_LABEL,
    restart: () => process.kill(process.pid, 'SIGTERM'),
    run: (cmd, args, opts) => nodeProcessRunner(cmd === 'pnpm' ? pnpm : cmd, args, opts),
    checks,
    // the assistant's own apps next to it (~/ax-kit-apps): the room may change, check, build them too
    apps: () => detectApps(nodeProcessRunner, homedir(), home),
    coder: () => {
      const claude = resolveCommand('claude');
      if (claude !== undefined) return new ClaudeCliCoder({ run: nodeProcessRunner, command: claude, timeoutMs: CODER_TIMEOUT_MS });
      const codex = resolveCommand('codex');
      return codex !== undefined ? new CodexCliCoder({ run: nodeProcessRunner, command: codex, timeoutMs: CODER_TIMEOUT_MS }) : undefined;
    },
  };
}
