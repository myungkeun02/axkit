import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { KeychainSecretStore, defaultHome } from '../core/index.js';
import { connectGoogleCommand, openInBrowser, pairCommand } from './commands.js';
import { googleAccountsCommand } from './google-accounts.js';
import { doctorFailed, formatDoctor, runDoctor } from './doctor.js';
import { phoneCommand } from './phone.js';
import type { PhoneFlags } from './phone.js';
import { execFileResult, phoneDeps } from './phone-deps.js';
import { createTtyPrompter } from './prompter.js';
import { runSecretDelete, runSecretSet } from './secret.js';
import { killCommand } from './kill.js';
import { onboardingCommand } from './onboarding-cmd.js';
import type { ServiceDeps } from './service.js';
import { LAUNCHD_LABEL, serviceInstall, serviceStatus, serviceUninstall } from './service.js';
import { featuresCommand, setupCommand, setupFeaturesCommand } from './setup-command.js';
import { updateCommand } from './update.js';
import { runStart } from './start.js';
import { remoteCommand, sourceCommand } from './source-command.js';

const CLI_OPTIONS = {
  home: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  platform: { type: 'string' },
  name: { type: 'string' },
  out: { type: 'string' },
  yes: { type: 'boolean' },
  fix: { type: 'boolean' },
  app: { type: 'boolean' },
  build: { type: 'boolean' },
  to: { type: 'string' },
  user: { type: 'string' },
  ssh: { type: 'string' },
} as const;

const HELP = `ax-kit — a personal AI assistant on your Mac

Usage:
  ax-kit setup [--home <dir>]   기본 설정 (처음 한 번, 7단계)
  ax-kit setup features         선택 기능 켜고 끄기 (카톡 PC 읽기·브라우저 심부름·받아쓰기 등)
  ax-kit doctor [--home <dir>]
  ax-kit start [--home <dir>]
  ax-kit stop [reason]          보내기·결제·삭제를 모두 멈춤
  ax-kit resume                 다시 켬
  ax-kit onboarding restart     처음 알아보기를 다시 시작 (status · review · stop · resume)
  ax-kit onboarding status      처음 알아보기 진행 막대와 결과 (review: 말로 고치고 팀 만들기)
  ax-kit stop status
  ax-kit secret set <name>
  ax-kit secret delete <name>
  ax-kit service install [--home <dir>]
  ax-kit service uninstall [--home <dir>]
  ax-kit service status [--home <dir>]
  ax-kit connect google [--home <dir>]
  ax-kit connect google add | accounts | remove <주소>   구글 계정 더 연결하기 · 목록 · 빼기
  ax-kit pair [--home <dir>]
  ax-kit phone pair [--platform ios|android] [--name <device name>]
  ax-kit phone pair --app [--name <device name>]
  ax-kit phone apk [--build]
  ax-kit phone list
  ax-kit phone rotate <device id>
  ax-kit phone revoke <device id> [--yes]
  ax-kit phone template --out <dir> [--yes]
  ax-kit phone funnel [--fix]
  ax-kit phone push-test [<device id>]
  ax-kit remote add | list | remove <name>   다른 맥(작업용 맥북)의 파일 연결
  ax-kit remote install [--ssh <사용자@주소>]  다른 맥에 설치·연결 (--ssh: 원격 로그인으로, 묻지 않고 기본값)
  ax-kit source setup | serve | pair | install | uninstall | status | revoke <name|all>
                         작업용 맥에서: 고른 폴더를 비서가 있는 맥에 읽기 전용으로 보여 줌
  ax-kit features        what is on, what is off, and how to turn it on
  ax-kit features add    same as ax-kit setup features
  ax-kit update          newest code, packages, service restart
  ax-kit help
  ax-kit --version

Options:
  --home <dir>   data directory (default: ~/.ax-kit)
  --platform     platform for \`phone pair\`: ios or android (with --app also desktop)
  --name         device name for \`phone pair\`
  --out <dir>    output directory for \`phone template\`
  --yes          skip confirmations (\`phone revoke\`, \`phone template\` overwrite)
  --fix          make the single /m path fix \`phone funnel\` offers
  -h, --help     show this help
  -v, --version  show the version`;

function parseCli(argv: readonly string[]) {
  return parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: CLI_OPTIONS });
}

function printHelp(): void {
  console.log(HELP);
}

async function packageVersion(): Promise<string> {
  const text = await readFile(new URL('../../package.json', import.meta.url), 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed === 'object' && parsed !== null && 'version' in parsed && typeof parsed.version === 'string') {
    return parsed.version;
  }
  return '0.0.0';
}


function phoneFlags(values: ReturnType<typeof parseCli>['values']): PhoneFlags {
  return {
    ...(values.platform !== undefined ? { platform: values.platform } : {}),
    ...(values.name !== undefined ? { name: values.name } : {}),
    ...(values.out !== undefined ? { out: values.out } : {}),
    ...(values.yes === true ? { yes: true } : {}),
    ...(values.fix === true ? { fix: true } : {}),
    ...(values.app === true ? { app: true } : {}),
    ...(values.build === true ? { build: true } : {}),
    ...(values.to !== undefined ? { to: values.to } : {}),
    ...(values.user !== undefined ? { user: values.user } : {}),
  };
}

function serviceDeps(home: string): ServiceDeps {
  return {
    home,
    launchAgentsDir: join(userInfo().homedir, 'Library', 'LaunchAgents'),
    uid: userInfo().uid,
    nodePath: process.execPath,
    entry: fileURLToPath(new URL('../../bin/ax-kit.mjs', import.meta.url)),
    exec: execFileResult,
    writeFile: async (path, text) => {
      await writeFile(path, text, { mode: 0o600 });
    },
    removeFile: async (path) => {
      await rm(path, { force: true });
    },
    mkdir: async (path) => {
      await mkdir(path, { recursive: true, mode: 0o700 });
    },
    say: (line) => {
      console.log(line);
    },
  };
}

async function doctorCommand(home: string): Promise<number> {
  const checks = await runDoctor({
    home,
    secrets: new KeychainSecretStore(),
    checkLaunchd: async () => {
      const result = await execFileResult('launchctl', ['print', `gui/${userInfo().uid}/${LAUNCHD_LABEL}`]);
      return result.code === 0;
    },
  });
  console.log(formatDoctor(checks));
  return doctorFailed(checks) ? 1 : 0;
}

async function serviceCommand(action: string | undefined, home: string): Promise<number> {
  if (action !== 'install' && action !== 'uninstall' && action !== 'status') {
    printHelp();
    return 2;
  }
  const deps = serviceDeps(home);
  if (action === 'install') return await serviceInstall(deps);
  if (action === 'uninstall') return await serviceUninstall(deps);
  return await serviceStatus(deps);
}

async function secretCommand(positionals: readonly string[]): Promise<number> {
  const action = positionals[1];
  const name = positionals[2];
  if ((action !== 'set' && action !== 'delete') || name === undefined) {
    printHelp();
    return 2;
  }

  const prompter = createTtyPrompter();
  const secrets = new KeychainSecretStore();
  if (action === 'set') await runSecretSet(name, prompter, secrets);
  else await runSecretDelete(name, prompter, secrets);
  return 0;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let args: ReturnType<typeof parseCli>;
  try {
    args = parseCli(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printHelp();
    return 2;
  }

  const { values, positionals } = args;
  if (values.version === true) {
    console.log(await packageVersion());
    return 0;
  }

  const command = positionals[0];
  if (values.help === true || command === 'help') {
    printHelp();
    return 0;
  }
  if (command === undefined) {
    printHelp();
    return 2;
  }

  const home = values.home ?? defaultHome();
  switch (command) {
    case 'setup':
      if (positionals[1] === 'features') return await setupFeaturesCommand(home, { installService: () => serviceInstall(serviceDeps(home)) });
      return await setupCommand(home, {
        installService: () => serviceInstall(serviceDeps(home)),
        // the iPhone *app* (not the Shortcuts signals): --app, as an iOS device
        pair: () => phoneCommand(['phone', 'pair'], { platform: 'ios', ...phoneFlags(values), app: true }, phoneDeps(home)),
        pairApp: (platform, name) => phoneCommand(['phone', 'pair'], { app: true, platform, name }, phoneDeps(home)),
        funnel: (fix) => phoneCommand(['phone', 'funnel'], fix ? { fix: true } : {}, phoneDeps(home)),
        installMac: () => phoneCommand(['phone', 'install-mac'], {}, phoneDeps(home)),
      });
    case 'features':
      if (positionals[1] === 'add') return await setupFeaturesCommand(home, { installService: () => serviceInstall(serviceDeps(home)) });
      return await featuresCommand(home);
    case 'update':
      return await updateCommand((line) => console.log(line));
    case 'doctor':
      return await doctorCommand(home);
    case 'start':
      await runStart(home);
      return 0;
    case 'stop':
      return await killCommand(home, positionals[1] === 'status' ? 'status' : 'stop', positionals.slice(1).join(' '));
    case 'resume':
      return await killCommand(home, 'resume', '');
    case 'secret':
      return await secretCommand(positionals);
    case 'service':
      return await serviceCommand(positionals[1], home);
    case 'connect':
      if (positionals[1] !== 'google') {
        printHelp();
        return 2;
      }
      if (positionals[2] === 'add' || positionals[2] === 'accounts' || positionals[2] === 'remove') {
        return await googleAccountsCommand(positionals[2], positionals[3], home, openInBrowser);
      }
      return await connectGoogleCommand(home);
    case 'pair':
      return await pairCommand(home);
    case 'phone':
      return await phoneCommand(positionals, phoneFlags(values), phoneDeps(home));
    case 'onboarding':
      return await onboardingCommand(positionals[1], { home });
    case 'source':
      return await sourceCommand(positionals);
    case 'remote':
      return await remoteCommand(positionals, home, values.ssh);
    default:
      printHelp();
      return 2;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
