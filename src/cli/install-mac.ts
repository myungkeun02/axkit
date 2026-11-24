import { join } from 'node:path';
import type { Config } from '../core/config/schema.js';
import { installCommand } from '../mobile/install-links.js';
import { appPairingLink } from './phone-app.js';
import type { PhoneCliDeps } from './phone.js';
import type { Exec } from './tailscale.js';
import { findTailscale } from './tailscale.js';

/** Where this Mac keeps the desktop app it hands to the owner's other Macs. */
export function desktopZipPath(home: string): string {
  return join(home, 'dist', 'ax-kit-desktop.zip');
}

export interface TailnetMac {
  name: string;
  dnsName: string;
  online: boolean;
}

/** The other Macs on this tailnet (`tailscale status --json` peers whose OS is macOS), online first. */
export async function tailnetMacs(exec: Exec): Promise<TailnetMac[]> {
  const bin = await findTailscale(exec);
  if (bin === undefined) return [];
  const result = await exec(bin, ['status', '--json']).catch(() => undefined);
  if (result?.code !== 0) return [];
  let root: { Peer?: Record<string, { HostName?: string; DNSName?: string; OS?: string; Online?: boolean }> };
  try {
    root = JSON.parse(result.stdout) as typeof root;
  } catch {
    return [];
  }
  return Object.values(root.Peer ?? {})
    .filter((peer) => peer.OS === 'macOS' && typeof peer.DNSName === 'string')
    .map((peer) => ({ name: peer.HostName ?? peer.DNSName ?? '', dnsName: (peer.DNSName ?? '').replace(/\.$/, ''), online: peer.Online === true }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** The app to hand out: the zip kept here, or one made from this Mac's own installed app. */
/** The public desktop app (built once, unsigned) for a Mac that has neither its own build nor the app. */
export const DESKTOP_RELEASE = 'https://github.com/myungkeun02/axkit-desktop/releases/latest/download';

async function downloadDesktopZip(home: string, exec: Exec, zip: string): Promise<string | undefined> {
  await exec('mkdir', ['-p', join(home, 'dist')]);
  const part = `${zip}.part`;
  const got = await exec('curl', ['-fsSL', '--max-time', '600', '-o', part, `${DESKTOP_RELEASE}/ax-kit-desktop.zip`]).catch(() => undefined);
  if (got?.code !== 0) return undefined;
  // the build info lets paired Mac apps offer this version as an update; without it the zip still installs
  await exec('curl', ['-fsSL', '--max-time', '60', '-o', zip.replace(/\.zip$/, '.json'), `${DESKTOP_RELEASE}/ax-kit-desktop.json`]).catch(() => undefined);
  const moved = await exec('mv', ['-f', part, zip]).catch(() => undefined);
  return moved?.code === 0 ? zip : undefined;
}

export async function ensureDesktopZip(home: string, exec: Exec, exists: (path: string) => Promise<boolean>, app = '/Applications/ax-kit.app'): Promise<string | undefined> {
  const zip = desktopZipPath(home);
  if (await exists(zip)) return zip;
  if (!(await exists(app))) return await downloadDesktopZip(home, exec, zip);
  await exec('mkdir', ['-p', join(home, 'dist')]);
  const made = await exec('ditto', ['-c', '-k', '--keepParent', app, zip]).catch(() => undefined);
  return made?.code === 0 ? zip : undefined;
}

export interface InstallMacDeps {
  phone: PhoneCliDeps;
  exec: Exec;
  exists: (path: string) => Promise<boolean>;
  /** Runs a command on the other Mac over Tailscale SSH, showing its output; the exit code. */
  ssh: (target: string, command: string) => Promise<number>;
}

/**
 * Puts the desktop app on one of the owner's other Macs and pairs it: pick the Mac from the tailnet, then either run the
 * install over Tailscale SSH (when that Mac allows it) or show the one line to paste in its terminal.
 */
export async function installOnMac(deps: InstallMacDeps, config: Config, publicUrl: string, options: { to?: string; user?: string } = {}): Promise<number> {
  const { phone } = deps;
  const zip = await ensureDesktopZip(phone.home, deps.exec, deps.exists);
  if (zip === undefined) {
    phone.say(`나눠 줄 데스크톱 앱이 이 맥에 없고, 공개된 앱도 받지 못했어요. 인터넷 연결을 확인하고 다시 해 주세요 (또는 ${desktopZipPath('~/.ax-kit')} 파일을 이 맥에 넣어 주세요).`);
    return 1;
  }
  const macs = await tailnetMacs(deps.exec);
  let target = macs.find((mac) => options.to !== undefined && (mac.name === options.to || mac.dnsName === options.to || mac.dnsName.startsWith(`${options.to}.`)));
  if (target === undefined && macs.length > 0) {
    const choice = await phone.prompter.choose(
      '어느 맥에 설치할까요? (Tailscale에 같은 계정으로 로그인한 맥들이에요)',
      [...macs.map((mac) => ({ value: mac.dnsName, label: mac.name, hint: mac.online ? '켜져 있음' : '꺼져 있음' })), { value: '', label: '목록에 없어요 (직접 붙여 넣을 한 줄만 받기)' }],
      0,
    );
    target = macs.find((mac) => mac.dnsName === choice);
  }

  const handle = phone.openAdmin(phone.home);
  let command: string;
  try {
    const name = target !== undefined ? `${target.name}의 데스크톱 앱` : '다른 맥의 데스크톱 앱';
    const result = await handle.admin.pair({ name, platform: 'desktop', client: 'app' });
    await handle.admin.attachFiles(result.pairing.nonce, [], `${publicUrl}|${result.token}`);
    const pair = appPairingLink(publicUrl, result.pairing.nonce, result.pairing.code);
    command = installCommand(await handle.install.create({ zip, base: publicUrl, pair }));
  } finally {
    await handle.close();
  }

  if (target !== undefined && target.online) {
    const user = options.user ?? (await phone.prompter.text(`${target.name}에서 쓰는 사용자 이름`, { default: process.env['USER'] ?? '' })).trim();
    phone.say(`${target.name}에 설치하고 연결하는 중이에요…`);
    const code = await deps.ssh(user !== '' ? `${user}@${target.dnsName}` : target.dnsName, command).catch(() => 1);
    if (code === 0) {
      phone.say(`✓ ${target.name}에 설치했어요. 그 맥에서 앱이 열리고 비서와 연결돼요.`);
      return 0;
    }
    phone.say(`${target.name}에 원격으로 들어가지 못했어요. 그 맥의 Tailscale에서 "SSH 허용"이 꺼져 있으면 이렇게 돼요.`);
  }
  phone.say(`${target?.name ?? '그 맥'}의 터미널(응용 프로그램 › 유틸리티 › 터미널)에 아래 한 줄을 붙여 넣고 엔터를 눌러 주세요. 앱을 받아 설치하고 연결까지 해요 (10분 안에, 한 번만):`);
  phone.say(`  ${command}`);
  return 0;
}
