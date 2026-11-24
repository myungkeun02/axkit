import { describe, expect, it } from 'vitest';
import { MobileAdmin } from '../../src/mobile/admin.js';
import { ApkLinks } from '../../src/mobile/apk-links.js';
import { InstallLinks, installCommand, installScript } from '../../src/mobile/install-links.js';
import { installOnMac, tailnetMacs } from '../../src/cli/install-mac.js';
import type { PhoneCliDeps } from '../../src/cli/phone.js';
import type { Exec } from '../../src/cli/tailscale.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { FakeClock, MapKeyValueStore } from '../core/helpers.js';

const NOW = new Date('2026-11-24T13:00:00+09:00');
const STATUS = JSON.stringify({ Self: { DNSName: 'office-mini.tail1.ts.net.' }, Peer: { a: { HostName: 'work-macbook', DNSName: 'work-macbook.tail1.ts.net.', OS: 'macOS', Online: true }, b: { HostName: 'iphone', DNSName: 'iphone.tail1.ts.net.', OS: 'iOS', Online: true }, c: { HostName: 'old-imac', DNSName: 'old-imac.tail1.ts.net.', OS: 'macOS', Online: false } } });

function setup(sshCode: number) {
  const said: string[] = [];
  const kv = new MapKeyValueStore();
  const clock = new FakeClock(NOW);
  const admin = new MobileAdmin({ kv, clock });
  const install = new InstallLinks(kv, clock);
  const exec: Exec = async (cmd, args) => (args[0] === 'status' ? { code: 0, stdout: STATUS, stderr: '' } : { code: cmd === 'tailscale' && args[0] === 'version' ? 0 : 0, stdout: '', stderr: '' });
  const ssh: { target: string; command: string }[] = [];
  const phone = { home: '/h/.ax-kit', say: (line: string) => void said.push(line), prompter: createScriptedPrompter(['work-macbook.tail1.ts.net', 'theo']), openAdmin: () => ({ admin, apk: new ApkLinks(kv, clock), install, close: async () => {} }) } as unknown as PhoneCliDeps;
  const deps = { phone, exec, exists: async (path: string) => path.endsWith('ax-kit-desktop.zip'), ssh: async (target: string, command: string) => (ssh.push({ target, command }), sshCode) };
  return { deps, said, ssh, install, kv };
}

describe('desktop app on another Mac of the tailnet', () => {
  it('lists the Macs, online first, and leaves out phones', async () => {
    const exec: Exec = async (_cmd, args) => ({ code: 0, stdout: args[0] === 'status' ? STATUS : '', stderr: '' });
    expect((await tailnetMacs(exec)).map((mac) => [mac.name, mac.online])).toEqual([['work-macbook', true], ['old-imac', false]]);
  });

  it('installs and pairs over Tailscale SSH on the chosen Mac', async () => {
    const { deps, said, ssh } = setup(0);
    expect(await installOnMac(deps, {} as never, 'https://office-mini.tail1.ts.net')).toBe(0);
    expect(ssh[0]?.target).toBe('theo@work-macbook.tail1.ts.net');
    expect(ssh[0]?.command).toMatch(/^curl -fsSL https:\/\/office-mini\.tail1\.ts\.net\/m\/install\/[A-Za-z0-9_-]+ \| bash$/);
    expect(said.at(-1)).toContain('work-macbook에 설치했어요');
  });

  it('falls back to the one line to paste when SSH is not allowed there', async () => {
    const { deps, said } = setup(255);
    await installOnMac(deps, {} as never, 'https://office-mini.tail1.ts.net');
    expect(said.join('\n')).toContain('SSH 허용');
    expect(said.at(-1)).toMatch(/curl -fsSL https:\/\/office-mini.tail1.ts.net\/m\/install\//);
  });

  it('the script downloads, installs into Applications and opens the pairing link; links expire', async () => {
    const clock = new FakeClock(NOW);
    const links = new InstallLinks(new MapKeyValueStore(), clock);
    const link = await links.create({ zip: '/z.zip', base: 'https://m.ts.net/', pair: 'axkit://pair?u=https%3A%2F%2Fm.ts.net&n=abc&c=123456' });
    const script = installScript(link);
    expect(script).toContain(`ZIP_URL='https://m.ts.net/m/install/${link.nonce}/app.zip'`);
    expect(script).toContain('xattr -dr com.apple.quarantine');
    expect(script).toContain('open "$PAIR"');
    expect(installCommand(link)).toBe(`curl -fsSL https://m.ts.net/m/install/${link.nonce} | bash`);
    await expect(links.create({ zip: '/z', base: 'https://m.ts.net', pair: "axkit://pair?x=';rm -rf /'" })).rejects.toThrow('Unsafe');
    await expect(links.create({ zip: '/z', base: 'http://m.ts.net', pair: 'axkit://pair?n=a' })).rejects.toThrow('Unsafe');
    await clock.advance(11 * 60_000);
    expect(await links.find(link.nonce)).toBeUndefined();
  });
});
