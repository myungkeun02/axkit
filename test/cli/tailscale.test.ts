import { describe, expect, it } from 'vitest';
import {
  TAILSCALE_APP_PATH,
  findTailscale,
  funnelServesPath,
  servesPath,
  tailscaleStatus,
} from '../../src/cli/tailscale.js';
import type { Exec, ExecResult } from '../../src/cli/tailscale.js';

const RUNNING = JSON.stringify({
  BackendState: 'Running',
  Self: { DNSName: 'box.tail1234.ts.net.' },
});

interface Call {
  cmd: string;
  args: readonly string[];
}

function execOf(handlers: Record<string, ExecResult | (() => never)>): { calls: Call[]; exec: Exec } {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    const key = `${cmd} ${args.join(' ')}`;
    for (const [name, result] of Object.entries(handlers)) {
      if (key === name || key.startsWith(`${name} `)) {
        if (typeof result === 'function') return result();
        return result;
      }
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { calls, exec };
}

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };

describe('findTailscale', () => {
  it('prefers the binary on PATH', async () => {
    const { calls, exec } = execOf({ 'tailscale version': OK });
    expect(await findTailscale(exec)).toBe('tailscale');
    expect(calls).toHaveLength(1);
  });

  it('falls back to the app bundle when PATH has no command', async () => {
    const { calls, exec } = execOf({
      'tailscale version': () => {
        throw new Error('ENOENT');
      },
      [`${TAILSCALE_APP_PATH} version`]: OK,
    });
    expect(await findTailscale(exec)).toBe(TAILSCALE_APP_PATH);
    expect(calls.map((call) => call.cmd)).toEqual(['tailscale', TAILSCALE_APP_PATH]);
  });

  it('reports not installed when neither responds', async () => {
    const exec: Exec = async () => {
      throw new Error('ENOENT');
    };
    expect(await findTailscale(exec)).toBeUndefined();
    expect(await tailscaleStatus(exec)).toEqual({ installed: false, running: false });
  });
});

describe('tailscaleStatus', () => {
  it('parses BackendState and strips the trailing dot from DNSName', async () => {
    const { exec } = execOf({ 'tailscale version': OK, 'tailscale status --json': { code: 0, stdout: RUNNING, stderr: '' } });
    expect(await tailscaleStatus(exec)).toEqual({
      installed: true,
      running: true,
      dnsName: 'box.tail1234.ts.net',
    });
  });

  it('is installed but not running when status exits non-zero', async () => {
    const { exec } = execOf({
      'tailscale version': OK,
      'tailscale status --json': { code: 1, stdout: '', stderr: 'logged out' },
    });
    expect(await tailscaleStatus(exec)).toEqual({ installed: true, running: false });
  });

  it('treats unparseable status output as not running', async () => {
    const { exec } = execOf({ 'tailscale version': OK, 'tailscale status --json': { code: 0, stdout: 'nope', stderr: '' } });
    expect(await tailscaleStatus(exec)).toEqual({ installed: true, running: false });
  });
});

describe('funnelServesPath', () => {
  it('matches a routed path but not a longer prefix or a host URL', () => {
    expect(servesPath('|-- /m proxy http://127.0.0.1:47617/m', '/m')).toBe(true);
    expect(servesPath('|-- /mail proxy http://127.0.0.1:47617/m', '/m')).toBe(false);
    expect(servesPath('https://box.tail1234.ts.net/m', '/m')).toBe(false);
    expect(servesPath('# Funnel on:\n|-- /m proxy', '/m')).toBe(true);
  });

  it('reads `tailscale funnel status` and never changes settings', async () => {
    const { calls, exec } = execOf({
      'tailscale version': OK,
      'tailscale funnel status': {
        code: 0,
        stdout: '# Funnel on:\n|-- /m proxy http://127.0.0.1:47617/m',
        stderr: '',
      },
    });
    expect(await funnelServesPath(exec, '/m')).toBe(true);
    expect(calls.some((call) => call.args.includes('up'))).toBe(false);
    expect(calls.some((call) => call.args.includes('funnel') && call.args.includes('--bg'))).toBe(false);
  });

  it('is false when the command fails or the path is not routed', async () => {
    const failing = execOf({ 'tailscale version': OK, 'tailscale funnel status': { code: 1, stdout: '', stderr: '' } });
    expect(await funnelServesPath(failing.exec, '/m')).toBe(false);

    const other = execOf({ 'tailscale version': OK, 'tailscale funnel status': { code: 0, stdout: '|-- /other x', stderr: '' } });
    expect(await funnelServesPath(other.exec, '/m')).toBe(false);
  });
});
