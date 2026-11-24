import { execFile } from 'node:child_process';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { toString as qrToString } from 'qrcode';
import type { Config } from '../core/index.js';
import { KeychainSecretStore, configPath, loadConfig } from '../core/index.js';
import { nodeProcessRunner } from '../core/process/node-runner.js';
import { NO_JAVA, androidPaths, buildReleaseApk, fileExists } from '../app/android.js';
import { downloadReleaseApk } from '../app/android-release.js';
import { openPhoneAdmin, preparePhoneFiles } from '../app/phone.js';
import { funnelCommand } from './funnel.js';
import { pushTestCommand } from './phone-push.js';
import type { FunnelDeps } from './funnel.js';
import type { PhoneCliDeps } from './phone.js';
import type { ApkBuilder } from './phone-app.js';
import { createTtyPrompter } from './prompter.js';
import { tailscaleStatus } from './tailscale.js';
import { installOnMac } from './install-mac.js';
import { openQrPage } from './qr-page.js';
import { runAttached } from './update.js';

async function readExistingConfig(path: string): Promise<Config | undefined> {
  try {
    return await loadConfig(path);
  } catch {
    return undefined;
  }
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function execCode(error: unknown): number {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'number') return code;
  }
  return 1;
}

export function execFileResult(cmd: string, args: readonly string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : execCode(error), stdout, stderr });
    });
  });
}

function funnelDeps(home: string): FunnelDeps {
  return {
    exec: execFileResult,
    fetch: (url, init) => fetch(url, init),
    prompter: createTtyPrompter(),
    say: (line) => {
      console.log(line);
    },
    loadConfig: () => readExistingConfig(configPath(home)),
  };
}

async function makeDir(path: string, mode: number): Promise<void> {
  await mkdir(path, { recursive: true, mode });
}

async function writeMode(path: string, data: string, mode: number): Promise<void> {
  await writeFile(path, data, { mode });
}

export function phoneDeps(home: string): PhoneCliDeps {
  return {
    home,
    prompter: createTtyPrompter(),
    say: (line) => {
      console.log(line);
    },
    openAdmin: openPhoneAdmin,
    prepare: (input) =>
      preparePhoneFiles({ ...input, exec: execFileResult, writeFile: writeMode, mkdir: makeDir }),
    tailscale: () => tailscaleStatus(execFileResult),
    // also on a page in the browser, which is easier to scan than the terminal
    qr: async (text) => {
      const terminal = await qrToString(text, { type: 'terminal', small: true });
      const opened = await openQrPage(text, async (file) => (await execFileResult('open', [file])).code === 0).catch(() => false);
      return opened ? `${terminal}\n브라우저에도 QR을 크게 띄웠어요. 그 화면을 찍으면 돼요.` : terminal;
    },
    loadConfig: () => readExistingConfig(configPath(home)),
    mkdir: makeDir,
    writeFile: writeMode,
    readDir: async (path) => {
      try {
        return await readdir(path);
      } catch {
        return [];
      }
    },
    funnel: (flags) => funnelCommand(flags, funnelDeps(home)),
    apk: apkBuilder(home),
    installMac: async (config, publicUrl, options) =>
      await installOnMac(
        {
          phone: phoneDeps(home),
          exec: execFileResult,
          exists: async (path) => await access(path).then(() => true, () => false),
          // the owner's Tailscale SSH (no keys here); output shows as it runs
          // macOS's own Remote Login, reached over the tailnet: the Mac Tailscale app cannot take Tailscale SSH
          // ("No ED25519 host key is known"); the owner types that Mac's password here if it asks
          ssh: async (target, command) => await runAttached('/usr/bin/ssh', ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', target, command]),
        },
        config,
        publicUrl,
        options,
      ),
    pushTest: async (deviceId) => {
      const config = await readExistingConfig(configPath(home));
      if (config === undefined) {
        console.log('설정이 없어요. 먼저 `ax-kit setup`을 실행해 주세요.');
        return 1;
      }
      const say = (line: string): void => {
        console.log(line);
      };
      return await pushTestCommand({ home, config, secrets: new KeychainSecretStore(), say }, deviceId);
    },
  };
}

function apkBuilder(home: string): ApkBuilder {
  const deps = {
    home,
    secrets: new KeychainSecretStore(),
    run: nodeProcessRunner,
    ...(process.env['AXKIT_BUILD_LOCK'] !== undefined ? { buildLock: process.env['AXKIT_BUILD_LOCK'] } : {}),
  };
  return {
    existing: async () => {
      const path = androidPaths(home).apk;
      return (await fileExists(path)) ? path : undefined;
    },
    // a Mac without Java or the app code gets the public signed build instead
    build: async () =>
      await buildReleaseApk(deps).catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== NO_JAVA && !message.includes('앱 코드가 없어서')) throw error;
        console.log(`${message} 대신 공개된 앱을 받을게요…`);
        return await downloadReleaseApk(androidPaths(home).apk);
      }),
  };
}
