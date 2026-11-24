import type { AsideRunner } from './setup-google-aside.js';
import type { AsideInstall } from './setup-google-aside-install.js';
import type { ProjectCandidate } from '../skills/onboarding/projects.js';
import { access, readFile } from 'node:fs/promises';
import type { Config, ConfigInput } from '../core/config/schema.js';
import type { SecretStore } from '../core/secrets/types.js';
import { parseConfig, saveConfig } from '../core/config/load.js';
import {
  connectGoogleAccount,
  newPairingCode as defaultNewPairingCode,
  pairOwnerOnDiscord,
} from '../app/onboarding.js';
import { chooseOrType, summary } from './prompt-kit.js';
import type { AppDevice, AppStepDeps } from './setup-apps.js';
import type { BasicStepDeps, BasicStepResult } from './setup-defaults.js';
import { setupBasics } from './setup-defaults.js';
import { askApps } from './setup-apps.js';
import type { SetupStep } from './setup-steps.js';
import { runSteps } from './setup-steps.js';
import type { Prompter } from './prompter.js';
import { stayOnBack } from './prompter.js';
import { LLM_PRESETS, configureLlm } from './setup-llm.js';
import type { LlmSetupDeps } from './setup-llm.js';
import type { LlmSetupResult } from './setup-llm.js';
import type { CliConnectDeps } from './setup-llm-cli.js';
import type { WorkPlaceStep } from './setup-remote.js';
import type { VerifyDiscordToken } from './setup-discord.js';
import { configureDiscord } from './setup-discord.js';
import { askAssistant } from './setup-assistant.js';
import type { PairOwner } from './setup-owner.js';
import { askOwner } from './setup-owner.js';
import type { ConnectGoogle, GoogleStepResult } from './setup-google.js';
import { askGoogle, drivePluginEntry, gmailPluginEntry } from './setup-google.js';
import type { ScheduleAnswers } from './setup-schedule.js';
import { askSchedule } from './setup-schedule.js';
import { ONBOARDING_ID, askOnboarding } from './setup-onboarding.js';
import { askChannel } from './setup-channel.js';
import type { SetupOutcome } from './setup-summary.js';
import { nextSteps, summaryRows } from './setup-summary.js';
import type { TranscribeStepDeps } from './setup-transcribe.js';

export interface SetupDeps {
  prompter: Prompter;
  secrets: SecretStore;
  configFile: string;
  existing?: Config;
  detectTimezone?: () => string;
  verifyDiscordToken?: VerifyDiscordToken;
  newPairingCode?: () => string;
  pairOwner?: PairOwner;
  connectGoogle?: ConnectGoogle;
  readFile?: (path: string) => Promise<string>;
  fileExists?: (path: string) => Promise<boolean>;
  installService?: () => Promise<number>;
  openUrl?: (url: string) => Promise<void>;
  /** The basics step (everyday features on, installs, GitHub); tests that leave it out have one step fewer. */
  basics?: Omit<BasicStepDeps, 'prompter' | 'secrets' | 'existing'>;
  /** The apps step at the end (install + pair); without it setup only prints how. */
  apps?: AppStepDeps;
  /** Calls the chosen AI once before saving it. */
  checkProvider?: LlmSetupDeps['checkProvider'];
  /** Installs and signs in to Claude Code / Codex right in the AI step. */
  connectCli?: CliConnectDeps;
  /** Aside CLI: the Google Cloud side done in the owner's browser. */
  aside?: AsideRunner;
  asideInstall?: AsideInstall;
  /** Not asked in the first setup any more (it is an optional feature: `ax-kit setup features`); kept for callers. */
  transcribe?: Omit<TranscribeStepDeps, 'prompter'>;
  /** Offers the first-look scan; tests that leave it out have one step fewer. */
  onboarding?: { home: string; dirExists: (path: string) => Promise<boolean>; now?: () => Date; discover?: (folders: readonly string[]) => Promise<ProjectCandidate[]>; workPlace?: WorkPlaceStep };
  /** After the service is up and the owner said "바로 시작": the live first-look bar, the result and its corrections. */
  followFirstLook?: (prompter: Prompter) => Promise<unknown>;
}

const BUDGETS = ['0.5', '1', '3'] as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function readUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function openBrowserFallback(url: string): Promise<void> {
  throw new Error(`브라우저를 열지 못했어요. 직접 여세요: ${url}`);
}

function validBudget(value: string): string | undefined {
  const n = Number(value.replace(/^\$/, ''));
  return Number.isFinite(n) && n > 0 && n <= 100 ? undefined : '0보다 크고 100 이하인 숫자로 적어 주세요 (예: 2).';
}

/** Only for pay-as-you-go APIs; a subscription or a local model costs nothing per message. */
async function askBudget(prompter: Prompter, existing: Config | undefined): Promise<number> {
  const current = existing?.llm.budget.dailyUsd;
  const found = BUDGETS.findIndex((budget) => Number(budget) === current);
  const custom = current !== undefined && found < 0 ? [{ value: String(current), label: `$${current} (지금 설정)` }] : [];
  const choice = await chooseOrType(
    prompter,
    'AI에 하루 얼마까지 쓸까요? (넘으면 멈추고 알려 드려요)',
    [...BUDGETS.map((budget) => ({ value: budget, label: `$${budget}`, hint: `한 달 최대 $${Number(budget) * 20}` })), ...custom],
    { defaultIndex: found >= 0 ? found : custom.length > 0 ? BUDGETS.length : 1, type: { label: '다른 금액 직접 입력 ($)', placeholder: '2', validate: validBudget } },
  );
  const daily = Number(choice.replace(/^\$/, ''));
  return Number.isFinite(daily) && daily > 0 ? daily : 1;
}

function mergePlugins(existing: Config | undefined, briefing: ScheduleAnswers['briefing'], google: GoogleStepResult): Record<string, Record<string, unknown>> {
  const plugins: Record<string, Record<string, unknown>> = { ...(existing?.plugins ?? {}) };
  plugins['skill.briefing'] = briefing.enabled ? { enabled: true, ...(briefing.at !== undefined ? { at: briefing.at } : {}) } : { enabled: false };
  if (google.calendar !== undefined) plugins['connector.google-calendar'] = { enabled: google.calendar };
  if (google.gmail !== undefined) plugins['connector.gmail'] = gmailPluginEntry(existing, google);
  if (google.drive !== undefined) plugins['connector.google-drive'] = drivePluginEntry(existing, google.drive, google.driveFolders);
  Object.assign(plugins, google.workspace);
  return plugins;
}

function presetLabel(llm: LlmSetupResult): string | undefined {
  if (llm.providers.length === 0) return undefined;
  const ids = new Set(llm.providers.map((provider) => provider.id));
  return LLM_PRESETS.find((preset) => preset.providers.every((provider) => ids.has(provider.id)))?.label ?? llm.providers[0]?.id;
}

/** The first-time funnel: seven short steps, the basics only. Optional features come later (`ax-kit setup features`). */
export async function runSetup(deps: SetupDeps): Promise<Config> {
  const { prompter, secrets, existing } = deps;
  prompter.say('ax-kit 설정을 시작할게요. 화살표(↑↓)로 고르고 Enter로 넘어가요. ← 나 Esc는 이전 질문으로 (글자 칸에서는 < 를 적어요).');

  let assistant!: Awaited<ReturnType<typeof askAssistant>>;
  let llm: LlmSetupResult = { providers: [], routes: [] };
  let paid = false;
  let dailyUsd = existing?.llm.budget.dailyUsd ?? 1;
  let channel!: Awaited<ReturnType<typeof askChannel>>;
  let ownerId = existing?.owner.discordUserId;
  let google: GoogleStepResult = {};
  let schedule!: ScheduleAnswers;
  let onboarding: Record<string, Record<string, unknown>> = {};
  let basics: BasicStepResult | undefined;

  const steps: SetupStep[] = [
    {
      title: '비서',
      note: '비서의 이름과 말투를 정해요.',
      run: async (asker) => {
        assistant = await askAssistant({
          prompter: asker,
          ...(existing !== undefined ? { existing } : {}),
          ...(deps.detectTimezone !== undefined ? { detectTimezone: deps.detectTimezone } : {}),
        });
      },
    },
    {
      title: 'AI 연결',
      note: '비서가 생각할 때 쓰는 AI예요. 쓰고 있는 구독이나 API 키 하나면 돼요.',
      run: async (asker) => {
        llm = await configureLlm(asker, secrets, existing, { ...(deps.connectCli !== undefined ? { connectCli: deps.connectCli } : {}), ...(deps.checkProvider !== undefined ? { checkProvider: deps.checkProvider } : {}) });
        paid = llm.providers.some((provider) => provider.priceIn > 0 || provider.priceOut > 0);
        dailyUsd = paid ? await askBudget(asker, existing) : (existing?.llm.budget.dailyUsd ?? 1);
      },
    },
    {
      title: '대화할 곳',
      note: '비서와 어디서 이야기할지 정해요.',
      run: async (asker) => {
        channel = await askChannel(asker, existing, deps.apps === undefined || (await deps.apps.available?.().catch(() => true)) !== false);
        ownerId = existing?.owner.discordUserId;
        if (channel === 'app') return;
        const discord = await configureDiscord({
          prompter: asker,
          secrets,
          ...(deps.verifyDiscordToken !== undefined ? { verifyDiscordToken: deps.verifyDiscordToken } : {}),
          ...(deps.openUrl !== undefined ? { openUrl: deps.openUrl } : {}),
        });
        ownerId = await askOwner({
          prompter: asker,
          token: discord.token,
          language: assistant.language,
          ...(existing !== undefined ? { existing } : {}),
          newPairingCode: deps.newPairingCode ?? defaultNewPairingCode,
          pairOwner: deps.pairOwner ?? pairOwnerOnDiscord,
        });
      },
    },
    {
      title: '메일·캘린더',
      note: 'Google 메일·캘린더를 연결해요. 지금 어렵다면 "나중에"를 골라도 비서는 바로 쓸 수 있어요.',
      run: async (asker) => {
        google = await askGoogle({
          prompter: asker,
          secrets,
          openUrl: deps.openUrl ?? openBrowserFallback,
          connectGoogle: deps.connectGoogle ?? connectGoogleAccount,
          readFile: deps.readFile ?? readUtf8,
          fileExists: deps.fileExists ?? fileExists,
          ...(deps.aside !== undefined ? { aside: deps.aside } : {}),
          ...(deps.asideInstall !== undefined ? { asideInstall: deps.asideInstall } : {}),
          ...(existing !== undefined ? { existing } : {}),
        });
      },
    },
    {
      title: '기본 기능',
      note: '브라우저·생활 심부름 같은 기본 기능을 켜고 필요한 걸 설치해요. 계정이 필요한 것만 물어요.',
      when: () => deps.basics !== undefined,
      run: async (asker) => {
        if (deps.basics === undefined) return;
        basics = await setupBasics({ ...deps.basics, prompter: asker, secrets, ...(existing !== undefined ? { existing } : {}) });
      },
    },
    {
      title: '알림',
      note: '아침 브리핑과 방해받지 않을 시간을 정해요.',
      run: async (asker) => {
        schedule = await askSchedule({ prompter: asker, ...(existing !== undefined ? { existing } : {}) });
      },
    },
    {
      title: '처음 알아보기',
      note: '비서가 내 일을 미리 알아 두면 처음부터 알맞게 도와요.',
      when: () => deps.onboarding !== undefined,
      run: async (asker) => {
        const first = deps.onboarding;
        if (first === undefined) return;
        const driveConnected = google.drive === true || (google.drive === undefined && existing?.plugins['connector.google-drive']?.enabled === true);
        onboarding = {
          [ONBOARDING_ID]: await askOnboarding({
            prompter: asker,
            home: first.home,
            dirExists: first.dirExists,
            driveConnected,
            now: first.now ?? (() => new Date()),
            ...(first.discover !== undefined ? { discover: first.discover } : {}),
            ...(first.workPlace !== undefined ? { workPlace: first.workPlace } : {}),
            ...(existing !== undefined ? { existing } : {}),
          }),
        };
      },
    },
  ];
  await runSteps(prompter, steps, { title: '마무리', note: '설정을 저장하고 비서를 켜요.' });
  // after the steps there is nothing to go back to
  const after = stayOnBack(prompter);

  const config: ConfigInput = {
    version: 1,
    assistant: {
      name: assistant.name,
      language: assistant.language,
      tone: assistant.tone,
      timezone: assistant.timezone,
      ...(assistant.ownerName !== undefined ? { ownerName: assistant.ownerName } : {}),
      ...(schedule.quietHours !== undefined ? { quietHours: schedule.quietHours } : {}),
    },
    owner: ownerId !== undefined ? { discordUserId: ownerId } : {},
    channel,
    policy: { confirmWrites: schedule.confirmWrites, expiresMinutes: existing?.policy.expiresMinutes ?? 30 },
    llm: { providers: llm.providers, routes: llm.routes, budget: { dailyUsd, monthlyUsd: dailyUsd * 20 } },
    plugins: { ...mergePlugins(existing, schedule.briefing, google), ...(basics?.plugins ?? {}), ...onboarding },
  };
  await saveConfig(deps.configFile, config);
  const parsed = parseConfig(config);
  prompter.say(`저장했어요: ${deps.configFile}`);

  const install = await after.choose(
    '맥이 켜져 있으면 비서가 늘 실행되게 할까요?',
    [
      { value: 'install', label: '네, 등록할게요 (추천)', hint: '맥을 켜면 비서도 같이 켜져요 (launchd).' },
      { value: 'later', label: '나중에', hint: '그때는 ax-kit service install 로 등록해요.' },
    ],
    0,
  );
  let service: SetupOutcome['service'] = 'later';
  if (install === 'install') {
    if (deps.installService === undefined) prompter.say('`ax-kit service install`로 나중에 등록할 수 있어요.');
    else service = (await deps.installService()) === 0 ? 'installed' : 'failed';
    if (service === 'failed') prompter.say('서비스 등록에 실패했어요. `ax-kit service install`로 다시 시도해 주세요.');
  }

  // talking in the apps: install and pair them now (pairing needs the assistant running)
  let apps: AppDevice[] | undefined;
  if (channel !== 'discord' && service === 'installed' && deps.apps !== undefined) {
    prompter.say('');
    apps = await askApps(after, deps.apps);
  }

  const firstLook = onboarding[ONBOARDING_ID];
  const ai = presetLabel(llm);
  const outcome: SetupOutcome = {
    config: parsed,
    configFile: deps.configFile,
    ...(ai !== undefined ? { ai } : {}),
    ...(paid ? { dailyUsd } : {}),
    google,
    schedule,
    ...(firstLook !== undefined ? { firstLook: firstLook['enabled'] === false ? 'off' : firstLook['autoStart'] === true ? 'now' : 'later' } : {}),
    service,
    ...(apps !== undefined ? { apps } : {}),
  };
  summary(prompter, '이렇게 설정했어요', summaryRows(outcome), nextSteps(outcome));
  if (outcome.firstLook === 'now' && service === 'installed' && deps.followFirstLook !== undefined) {
    prompter.say('');
    prompter.say('비서가 켜졌어요. 처음 알아보기 진행을 여기서 보여 드릴게요.');
    await deps.followFirstLook(after);
  }
  return parsed;
}
