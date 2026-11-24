import type { Config, ConfigInput } from '../core/config/schema.js';
import { parseConfig, saveConfig } from '../core/config/load.js';
import type { SecretStore } from '../core/secrets/types.js';
import { confirm, step, summary } from './prompt-kit.js';
import type { Prompter } from './prompter.js';
import { FEATURES, askOptionalFeatures } from './setup-optional.js';
import type { TranscribeStepDeps } from './setup-transcribe.js';
import { setupTranscriber } from './setup-transcribe.js';

/**
 * `ax-kit setup features` (also `ax-kit features add`): the optional features the first setup no longer asks about.
 * The assistant also suggests them after its first look; this is the way to turn them on or off by hand.
 */
export interface FeatureSetupDeps {
  prompter: Prompter;
  secrets: SecretStore;
  configFile: string;
  existing: Config;
  transcribe?: Omit<TranscribeStepDeps, 'prompter'>;
  /** "비서가 자기 앱도 고치게" (asks first). */
  appDev?: () => Promise<unknown>;
  /** Restarts the background service so the change takes effect; left out = the owner is told how. */
  restartService?: () => Promise<number>;
}

export async function runFeatureSetup(deps: FeatureSetupDeps): Promise<Config> {
  const { prompter, existing } = deps;
  const total = deps.transcribe !== undefined ? 2 : 1;
  step(prompter, 1, total, '선택 기능', '필요한 것만 켜세요. 켜는 기능마다 무엇을 하고 무엇을 조심할지 먼저 알려 드려요.');
  const optional = await askOptionalFeatures({ prompter, secrets: deps.secrets, language: existing.assistant.language, existing });
  const input: ConfigInput = { ...existing, plugins: { ...existing.plugins, ...optional } };
  await saveConfig(deps.configFile, input);
  const config = parseConfig(input);

  let transcribe: boolean | undefined;
  if (deps.transcribe !== undefined) {
    step(prompter, 2, total, '녹음 받아쓰기', '회의 녹음을 이 맥에서 글로 바꿔요. 녹음은 맥 밖으로 나가지 않아요.');
    transcribe = await setupTranscriber({ ...deps.transcribe, prompter });
  }

  if (deps.appDev !== undefined) await deps.appDev().catch(() => undefined);

  const on = (ids: readonly string[]): boolean => ids.every((id) => config.plugins[id]?.enabled === true);
  const rows = FEATURES.filter((feature) => feature.pack !== true || on(feature.ids)).map((feature) => ({ label: on(feature.ids) ? '켜짐' : '꺼짐', value: feature.title, on: on(feature.ids) }));
  if (transcribe !== undefined) rows.push({ label: transcribe ? '켜짐' : '꺼짐', value: '녹음 받아쓰기 (맥 안 Whisper)', on: transcribe });
  const changed = JSON.stringify(existing.plugins) !== JSON.stringify(config.plugins);
  let restarted = false;
  if (changed && deps.restartService !== undefined && (await confirm(prompter, '바뀐 기능이 적용되게 비서를 지금 다시 시작할까요?', true))) {
    restarted = (await deps.restartService()) === 0;
  }
  summary(prompter, '선택 기능을 이렇게 정했어요', rows, [
    ...(changed && !restarted ? ['비서를 다시 시작하면 적용돼요: ax-kit service install (또는 ax-kit start)'] : []),
    '다시 바꾸려면: ax-kit setup features',
    '전체 상태 보기: ax-kit features',
  ]);
  return config;
}
