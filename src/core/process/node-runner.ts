import { spawn } from 'node:child_process';
import type { ProcessRunner, RunResult } from './types.js';

const MAX_OUTPUT_CHARS = 4_000_000;

function append(buffer: string, chunk: string): string {
  return buffer.length >= MAX_OUTPUT_CHARS ? buffer : (buffer + chunk).slice(0, MAX_OUTPUT_CHARS);
}

/** Production runner: no shell, bounded output, killed on timeout or abort (reported as `timedOut`). */
export const nodeProcessRunner: ProcessRunner = (cmd, args, opts) =>
  new Promise<RunResult>((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const kill = (): void => {
      timedOut = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(kill, opts.timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', kill);
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`Could not run "${cmd}": ${error.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => undefined);

    if (opts.signal?.aborted === true) kill();
    else opts.signal?.addEventListener('abort', kill, { once: true });
    child.stdin.end(opts.input ?? '');
  });
