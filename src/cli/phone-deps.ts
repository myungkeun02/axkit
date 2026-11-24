import { execFile } from 'node:child_process';
import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { toString as qrToString } from 'qrcode';
import type { Config } from '../core/index.js';
import { KeychainSecretStore, configPath, loadConfig } from '../core/index.js';
import { nodeProcessRunner } from '../core/process/node-runner.js';
import { androidPaths, buildReleaseApk, fileExists } from '../app/android.js';
import { openPhoneAdmin, preparePhoneFiles } from '../app/phone.js';
import { funnelCommand } from './funnel.js';
import { pushTestCommand } from './phone-push.js';
import type { FunnelDeps } from './funnel.js';
import type { PhoneCliDeps } from './phone.js';
import type { ApkBuilder } from './phone-app.js';
import { createTtyPrompter } from './prompter.js';
import { findTailscale, tailscaleStatus } from './tailscale.js';
import { installOnMac } from './install-mac.js';
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
    qr: (text) => qrToString(text, { type: 'terminal', small: true }),
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
          ssh: async (target, command) => await runAttached((await findTailscale(execFileResult)) ?? 'tailscale', ['ssh', target, '--', 'bash', '-c', command]),
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
    build: () => buildReleaseApk(deps),
  };
}
