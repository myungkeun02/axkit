import { join } from 'node:path';
import { checkProvider } from './setup-llm-check.js';
import type { AsideRunner } from './setup-google-aside.js';
import { nodeAsideRunner } from './setup-google-aside.js';
import type { AsideInstall } from './setup-google-aside-install.js';
import { ASIDE_CLI_INSTALL, asideAppInstalled } from './setup-google-aside-install.js';
import { nodeCliConnect } from './setup-llm-cli.js';
import { nodeAppDevDeps, nodeBasicDeps } from './setup-defaults-node.js';
import type { AppStepDeps } from './setup-apps.js';
import { appLinksFromEnv } from './setup-apps.js';
import { nodeProcessRunner } from '../core/process/node-runner.js';
import { resolveCommand } from '../core/process/resolve-command.js';
import { access, mkdir, readFile, rename } from 'node:fs/promises';
import type { Config } from '../core/index.js';
import { KeychainSecretStore, configPath, loadConfig } from '../core/index.js';
import { connectGoogleAccount, newPairingCode, pairOwnerOnDiscord } from '../app/onboarding.js';
import { openInBrowser } from './commands.js';
import { featureRows, formatFeatures } from './features.js';
import { hasCommand, nodeFeatureDeps } from './features-deps.js';
import { PromptCancelled, createTtyPrompter, stayOnBack } from './prompter.js';
import type { Prompter } from './prompter.js';
import { runSetup } from './setup.js';
import { runFeatureSetup } from './setup-features.js';
import { runSetupMissing } from './setup-missing.js';
import { nodeOnboardingDeps } from './setup-onboarding.js';
import { nodeRemoteOnboarding } from './setup-remote.js';
import type { TranscribeStepDeps } from './setup-transcribe.js';
import { setupAppDev } from './setup-app-dev.js';
import { runAttached } from './update.js';
import { followFirstLook, nodeFirstLookDeps } from './first-look-cli.js';

async function readExisting(path: string): Promise<Config | undefined> {
  try {
    return await loadConfig(path);
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

export interface SetupCommandDeps {
  installService: () => Promise<number>;
  pair: () => Promise<number>;
  /** `ax-kit phone pair --app --platform <p> --name <n>`. */
  pairApp: (platform: 'ios' | 'android' | 'desktop', name: string) => Promise<number>;
  /** `phone install-mac`: pick a Mac on the tailnet, install the desktop app there and pair it. */
  installMac?: () => Promise<number>;
  /** `ax-kit phone funnel [--fix]`. */
  funnel: (fix: boolean) => Promise<number>;
}

function transcribeDeps(home: string): Omit<TranscribeStepDeps, 'prompter'> {
  return {
    home,
    hasCommand,
    exists,
    run: (cmd, args) => runAttached(cmd, args),
    mkdir: async (path) => void (await mkdir(path, { recursive: true })),
    rename,
  };
}

/** Esc / Ctrl+C on any question ends the command cleanly: the terminal is already restored, nothing half-saved. */
async function cancellable(prompter: Prompter, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof PromptCancelled)) throw error;
    prompter.say('');
    prompter.say('설정을 멈췄어요. 이어서 하려면 다시 ax-kit setup 을 실행하세요.');
    return 130;
  }
}

/**
 * `ax-kit setup` (R18): the first time, the basic steps only; afterwards it shows the feature table and offers to fill
 * in what is off, turn optional features on, or start over. Safe to run as often as you like.
 */
export async function setupCommand(home: string, deps: SetupCommandDeps): Promise<number> {
  const configFile = configPath(home);
  const existing = await readExisting(configFile);
  const tty = createTtyPrompter({ allowBack: true });
  const prompter = stayOnBack(tty);
  const secrets = new KeychainSecretStore();
  const asideRunner = (): AsideRunner | undefined => nodeAsideRunner(resolveCommand, (cmd, args, timeoutMs) => nodeProcessRunner(cmd, args, { timeoutMs }));
  const aside = asideRunner();
  const asideInstall: AsideInstall = {
    appInstalled: () => asideAppInstalled(),
    runner: asideRunner,
    installCli: () => runAttached('bash', ['-c', ASIDE_CLI_INSTALL]),
    openUrl: openInBrowser,
  };
  const asideDeps = aside !== undefined ? { aside } : { asideInstall };
  const apps: AppStepDeps = {
    pair: (platform, name) => deps.pairApp(platform, name),
    funnel: (fix) => deps.funnel(fix),
    ...(deps.installMac !== undefined ? { installMac: deps.installMac } : {}),
    desktopInstalled: () => exists('/Applications/ax-kit.app'),
    links: appLinksFromEnv(),
    available: async () => Object.keys(appLinksFromEnv()).length > 0 || (await exists('/Applications/ax-kit.app')) || (await exists(join(home, 'dist', 'ax-kit-desktop.zip'))),
    openUrl: openInBrowser,
  };
  const google = { openUrl: openInBrowser, connectGoogle: connectGoogleAccount, readFile: (path: string) => readFile(path, 'utf8'), fileExists: exists, ...asideDeps };

  return await cancellable(prompter, async () => {
    if (existing !== undefined) {
      prompter.say(formatFeatures(await featureRows(nodeFeatureDeps(home, existing, secrets))));
      prompter.say('');
      const mode = await prompter.choose('이미 설정돼 있어요. 어떻게 할까요?', [
        { value: 'missing', label: '꺼진 것만 이어서 설정 (추천)', hint: 'AI·메일·캘린더·처음 알아보기처럼 기본 기능 중 꺼진 것만 물어요.' },
        { value: 'features', label: '선택 기능 켜고 끄기', hint: '카톡 PC 읽기·브라우저 심부름·받아쓰기 같은 기능이에요 (ax-kit setup features).' },
        { value: 'all', label: '처음부터 전부 다시' },
        { value: 'quit', label: '그대로 두기' },
      ], 0);
      if (mode === 'quit') return 0;
      if (mode === 'features') {
        await runFeatureSetup({ prompter, secrets, configFile, existing, transcribe: transcribeDeps(home), appDev: () => setupAppDev(nodeAppDevDeps(prompter)), restartService: deps.installService });
        return 0;
      }
      if (mode === 'missing') {
        await runSetupMissing({
          prompter,
          secrets,
          configFile,
          existing,
          features: (config) => nodeFeatureDeps(home, config, secrets),
          google,
          connectCli: nodeCliConnect(),
          checkProvider: (provider, key, model) => checkProvider(provider, key, fetch, model),
          basics: nodeBasicDeps(tty, transcribeDeps(home)),
          installService: deps.installService,
          pair: deps.pair,
          onboarding: { ...nodeOnboardingDeps(), ...nodeRemoteOnboarding(home, secrets) },
        });
        return 0;
      }
    }
    await runSetup({
      prompter: tty,
      secrets,
      configFile,
      ...(existing !== undefined ? { existing } : {}),
      newPairingCode,
      pairOwner: pairOwnerOnDiscord,
      connectGoogle: connectGoogleAccount,
      readFile: google.readFile,
      fileExists: exists,
      connectCli: nodeCliConnect(),
          checkProvider: (provider, key, model) => checkProvider(provider, key, fetch, model),
      ...asideDeps,
      apps,
      basics: nodeBasicDeps(tty, transcribeDeps(home)),
      installService: deps.installService,
      openUrl: openInBrowser,
      onboarding: { ...nodeOnboardingDeps(), ...nodeRemoteOnboarding(home, secrets) },
      followFirstLook: (shown) => followFirstLook(nodeFirstLookDeps(home, shown), { start: true }),
    });
    return 0;
  });
}

/** `ax-kit setup features` / `ax-kit features add`: turn optional features on or off after the first setup. */
export async function setupFeaturesCommand(home: string, deps: Pick<SetupCommandDeps, 'installService'>): Promise<number> {
  const configFile = configPath(home);
  const existing = await readExisting(configFile);
  const prompter = createTtyPrompter();
  if (existing === undefined) {
    prompter.say('아직 기본 설정이 없어요. 먼저 ax-kit setup 을 실행해 주세요.');
    return 1;
  }
  const secrets = new KeychainSecretStore();
  return await cancellable(prompter, async () => {
    await runFeatureSetup({ prompter, secrets, configFile, existing, transcribe: transcribeDeps(home), appDev: () => setupAppDev(nodeAppDevDeps(prompter)), restartService: deps.installService });
    return 0;
  });
}

export async function featuresCommand(home: string): Promise<number> {
  const config = await readExisting(configPath(home));
  console.log(formatFeatures(await featureRows(nodeFeatureDeps(home, config, new KeychainSecretStore()))));
  console.log('');
  console.log('선택 기능(카톡 PC 읽기·브라우저 심부름·받아쓰기 등)을 켜거나 끄려면: ax-kit setup features');
  return 0;
}
