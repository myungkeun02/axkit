import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliRunner, CliRunResult } from './cli.js';
import { resolveCommand } from '../../process/resolve-command.js';

/** An empty working folder, so the CLI picks up no project instructions (CLAUDE.md, AGENTS.md). */
function emptyWorkdir(): string {
  const dir = join(tmpdir(), 'ax-kit-cli');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Production runner: spawn without a shell and feed the prompt through stdin. */
export const nodeCliRunner: CliRunner = (cmd, args, stdin, opts) =>
  new Promise<CliRunResult>((resolve, reject) => {
    // a login service's short PATH misses ~/.local/bin and Homebrew: look there too
    const child = spawn(resolveCommand(cmd) ?? cmd, args, { shell: false, cwd: emptyWorkdir(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    function cleanup(): void {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function done(result: CliRunResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      fail(new Error(`Could not run "${cmd}": ${error.message}`));
    });
    child.on('close', (code) => {
      done({ code: code ?? 1, stdout, stderr });
    });
    // A CLI that exits before reading its prompt closes stdin first; the exit code reports the real failure.
    child.stdin?.on('error', () => undefined);

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`"${cmd}" timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    const onAbort = (): void => {
      child.kill('SIGKILL');
      fail(new Error(`"${cmd}" was aborted`));
    };
    if (opts.signal?.aborted === true) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdin?.end(stdin);
  });
