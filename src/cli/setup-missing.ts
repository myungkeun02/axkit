import type { ProjectCandidate } from '../skills/onboarding/projects.js';
import type { Config, ConfigInput } from '../core/config/schema.js';
import { parseConfig, saveConfig } from '../core/config/load.js';
import type { SecretStore } from '../core/secrets/types.js';
import type { FeatureDeps } from './features.js';
import { featureRows, formatFeatures } from './features.js';
import type { Prompter } from './prompter.js';
import type { WorkPlaceStep } from './setup-remote.js';
import type { GoogleStepDeps } from './setup-google.js';
import type { CliConnectDeps } from './setup-llm-cli.js';
import { askGoogle, drivePluginEntry, gmailPluginEntry } from './setup-google.js';
import { askGoogleMissing } from './setup-google-missing.js';
import type { LlmSetupDeps } from './setup-llm.js';
import { configureLlm } from './setup-llm.js';
import type { BasicStepDeps } from './setup-defaults.js';
import { BASIC_ON, setupBasics } from './setup-defaults.js';
import { ONBOARDING_ID, askOnboarding } from './setup-onboarding.js';

/**
 * R18: `ax-kit setup` on a Mac that is already set up. Shows the feature table, then walks only through what is
 * off, so running it again is safe and quick. Steps that need another device (pairing, push keys) print the command.
 */
export interface MissingDeps {
  prompter: Prompter;
  secrets: SecretStore;
  configFile: string;
  existing: Config;
  features: (config: Config) => FeatureDeps;
  google: Omit<GoogleStepDeps, 'prompter' | 'secrets' | 'existing'>;
  connectCli?: CliConnectDeps;
  checkProvider?: LlmSetupDeps['checkProvider'];
  /** The basics (everyday features on, installs, GitHub) when any of them is still off. */
  basics?: Omit<BasicStepDeps, 'prompter' | 'secrets' | 'existing'>;
  installService?: () => Promise<number>;
  pair?: () => Promise<number>;
  onboarding?: { home: string; dirExists: (path: string) => Promise<boolean>; now?: () => Date; discover?: (folders: readonly string[]) => Promise<ProjectCandidate[]>; workPlace?: WorkPlaceStep };
}

export async function runSetupMissing(deps: MissingDeps): Promise<Config> {
  const { prompter, secrets } = deps;
  let config = deps.existing;
  const off = new Set((await featureRows(deps.features(config))).filter((row) => !row.on).map((row) => row.id));
  const plugins: Record<string, Record<string, unknown>> = { ...config.plugins };
  let llm = config.llm;

  if (off.has('ai')) {
    const result = await configureLlm(prompter, secrets, config, { ...(deps.connectCli !== undefined ? { connectCli: deps.connectCli } : {}), ...(deps.checkProvider !== undefined ? { checkProvider: deps.checkProvider } : {}) });
    llm = { ...llm, providers: result.providers, routes: result.routes };
  }
  // Mail or calendar off: the whole Google step. Otherwise one more sign-in for the opt-in parts that are off.
  const googleDeps = { ...deps.google, prompter, secrets, existing: config };
  const google = off.has('calendar') || off.has('gmail') ? await askGoogle(googleDeps) : await askGoogleMissing(googleDeps, off);
  if (google.calendar !== undefined) plugins['connector.google-calendar'] = { enabled: google.calendar };
  if (google.gmail !== undefined) plugins['connector.gmail'] = gmailPluginEntry(config, google);
  if (google.drive !== undefined) plugins['connector.google-drive'] = drivePluginEntry(config, google.drive, google.driveFolders);
  Object.assign(plugins, google.workspace);
  // the basics the first setup now turns on: offered here too when a Mac set up earlier still has them off
  if (deps.basics !== undefined && BASIC_ON.some((id) => config.plugins[id]?.enabled !== true)) {
    Object.assign(plugins, (await setupBasics({ ...deps.basics, prompter, secrets, existing: config })).plugins);
  }
  if (off.has('scan') && deps.onboarding !== undefined) {
    plugins[ONBOARDING_ID] = await askOnboarding({
      prompter,
      home: deps.onboarding.home,
      dirExists: deps.onboarding.dirExists,
      driveConnected: plugins['connector.google-drive']?.['enabled'] === true,
      now: deps.onboarding.now ?? (() => new Date()),
      ...(deps.onboarding.discover !== undefined ? { discover: deps.onboarding.discover } : {}),
      ...(deps.onboarding.workPlace !== undefined ? { workPlace: deps.onboarding.workPlace } : {}),
      existing: config,
    });
  }

  const input: ConfigInput = { ...config, llm, plugins };
  await saveConfig(deps.configFile, input);
  config = parseConfig(input);

  if (off.has('service') && deps.installService !== undefined) {
    const answer = await prompter.choose('맥이 켜져 있으면 늘 실행되게 등록할까요?', [
      { value: 'install', label: '지금 등록 (launchd)' },
      { value: 'later', label: '나중에' },
    ], 0);
    if (answer === 'install' && (await deps.installService()) !== 0) prompter.say('등록하지 못했어요. `ax-kit service install`로 다시 해 주세요.');
  }
  if (off.has('pair') && (config.channel === 'app' || config.channel === 'both') && deps.pair !== undefined) {
    const answer = await prompter.choose('아이폰 앱과 지금 연결할까요? (QR이 나와요)', [
      { value: 'pair', label: '지금 QR 보기' },
      { value: 'later', label: '나중에 (ax-kit phone pair --app --platform ios)' },
    ], 0);
    if (answer === 'pair') await deps.pair();
  }
  prompter.say('');
  prompter.say(formatFeatures(await featureRows(deps.features(config))));
  return config;
}
