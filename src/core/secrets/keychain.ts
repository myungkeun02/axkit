import { spawn } from 'node:child_process';
import type { SecretName, SecretStore } from './types.js';

export type ExecFn = (
  cmd: string,
  args: string[],
  input?: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const TIMEOUT_MS = 10_000;
const NAME_PATTERN = /^[a-z0-9][a-z0-9.:_-]{0,99}$/;

export const execFile: ExecFn = (cmd, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new Error(`Command timed out: ${cmd}`)));
    }, TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      finish(() => reject(new Error(`Failed to run ${cmd}: ${error.message}`)));
    });
    child.on('close', (code) => {
      finish(() => resolve({ code: code ?? -1, stdout, stderr }));
    });

    child.stdin.end(input);
  });

function assertName(name: SecretName): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid secret name: ${name}`);
  }
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

interface KeychainOptions {
  service?: string;
  exec?: ExecFn;
}

export class KeychainSecretStore implements SecretStore {
  private readonly service: string;
  private readonly exec: ExecFn;

  constructor(opts: KeychainOptions = {}) {
    this.service = opts.service ?? 'ax-kit';
    this.exec = opts.exec ?? execFile;
  }

  async get(name: SecretName): Promise<string | undefined> {
    assertName(name);
    const result = await this.exec('security', ['find-generic-password', '-s', this.service, '-a', name, '-w']);
    if (result.code === 0) return result.stdout.trim();
    if (result.code === 44) return undefined;
    throw new Error(`Could not read secret "${name}" (security exited ${result.code})`);
  }

  async set(name: SecretName, value: string): Promise<void> {
    assertName(name);
    if (/[\r\n\0]/.test(value)) {
      throw new Error(`Secret "${name}" must not contain line breaks or NUL characters`);
    }
    const command =
      `add-generic-password -U -s ${quote(this.service)} -a ${quote(name)} -w ${quote(value)}\n`;
    const result = await this.exec('security', ['-i'], command);
    if (result.code !== 0) {
      throw new Error(`Could not store secret "${name}" (security exited ${result.code})`);
    }
  }

  async delete(name: SecretName): Promise<void> {
    assertName(name);
    const result = await this.exec('security', ['delete-generic-password', '-s', this.service, '-a', name]);
    if (result.code !== 0 && result.code !== 44) {
      throw new Error(`Could not delete secret "${name}" (security exited ${result.code})`);
    }
  }

  async has(name: SecretName): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }
}
