import type { Config } from '../core/config/schema.js';
import type { Sensitivity, Tier } from '../core/llm/types.js';
import type { SecretStore } from '../core/secrets/types.js';
import { nodeCliRunner } from '../core/llm/providers/node-runner.js';
import type { Prompter } from './prompter.js';
import { PromptBack } from './prompter.js';
import type { LlmCheck } from './setup-llm-check.js';
import type { CliConnectDeps } from './setup-llm-cli.js';
import { connectCli } from './setup-llm-cli.js';

export interface LlmProviderPreset {
  id: string;
  kind: 'anthropic' | 'openai-compatible' | 'claude-cli' | 'codex-cli';
  baseUrl?: string;
  apiKeySecret?: string;
  /** Executable for CLI kinds. */
  command?: string;
  priceIn: number;
  priceOut: number;
}

export interface LlmRoutePreset {
  providerId: string;
  model: string;
  tiers: Tier[];
  maxSensitivity: Sensitivity;
}

export interface LlmPreset {
  id: string;
  label: string;
  /** Keychain name asked for once; providers in the preset share it. */
  apiKeySecret?: string;
  providers: readonly LlmProviderPreset[];
  routes: readonly LlmRoutePreset[];
}

/** All model ids and prices live here so a model refresh is a one-line change. */
export const LLM_PRESETS: readonly LlmPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    apiKeySecret: 'llm.anthropic.api-key',
    providers: [
      {
        id: 'anthropic',
        kind: 'anthropic',
        apiKeySecret: 'llm.anthropic.api-key',
        priceIn: 3,
        priceOut: 15,
      },
      {
        id: 'anthropic-haiku',
        kind: 'anthropic',
        apiKeySecret: 'llm.anthropic.api-key',
        priceIn: 1,
        priceOut: 5,
      },
    ],
    routes: [
      {
        providerId: 'anthropic',
        model: 'claude-sonnet-4-5',
        tiers: ['standard', 'deep'],
        maxSensitivity: 'sensitive',
      },
      {
        providerId: 'anthropic-haiku',
        model: 'claude-haiku-4-5',
        tiers: ['fast'],
        maxSensitivity: 'sensitive',
      },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT)',
    apiKeySecret: 'llm.openai.api-key',
    providers: [
      {
        id: 'openai',
        kind: 'openai-compatible',
        baseUrl: 'https://api.openai.com/v1',
        apiKeySecret: 'llm.openai.api-key',
        priceIn: 0.25,
        priceOut: 2,
      },
    ],
    routes: [
      {
        providerId: 'openai',
        model: 'gpt-5-mini',
        tiers: ['fast', 'standard', 'deep'],
        maxSensitivity: 'sensitive',
      },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    apiKeySecret: 'llm.deepseek.api-key',
    providers: [
      {
        id: 'deepseek',
        kind: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com',
        apiKeySecret: 'llm.deepseek.api-key',
        priceIn: 0.28,
        priceOut: 0.42,
      },
    ],
    routes: [
      {
        providerId: 'deepseek',
        model: 'deepseek-chat',
        tiers: ['fast', 'standard', 'deep'],
        maxSensitivity: 'masked',
      },
    ],
  },
  {
    id: 'ollama',
    label: '내 컴퓨터 모델 (Ollama)',
    providers: [
      {
        id: 'ollama',
        kind: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        priceIn: 0,
        priceOut: 0,
      },
    ],
    routes: [
      {
        providerId: 'ollama',
        model: 'llama3.1',
        tiers: ['fast', 'standard', 'deep'],
        maxSensitivity: 'sensitive',
      },
    ],
  },
  {
    id: 'claude-cli',
    label: 'Claude Code 구독 (claude CLI)',
    providers: [{ id: 'claude-cli', kind: 'claude-cli', command: 'claude', priceIn: 0, priceOut: 0 }],
    routes: [
      {
        providerId: 'claude-cli',
        model: 'sonnet',
        tiers: ['standard', 'deep'],
        maxSensitivity: 'sensitive',
      },
      {
        providerId: 'claude-cli',
        model: 'haiku',
        tiers: ['fast'],
        maxSensitivity: 'sensitive',
      },
    ],
  },
  {
    id: 'codex-cli',
    label: 'Codex 구독 (codex CLI)',
    providers: [{ id: 'codex-cli', kind: 'codex-cli', command: 'codex', priceIn: 0, priceOut: 0 }],
    routes: [
      {
        providerId: 'codex-cli',
        model: 'gpt-5-codex',
        tiers: ['fast', 'standard', 'deep'],
        maxSensitivity: 'sensitive',
      },
    ],
  },
];

export interface LlmSetupResult {
  providers: LlmProviderPreset[];
  routes: LlmRoutePreset[];
}

/** Returns true when the command is installed; injectable so setup never spawns in tests. */
export type CheckCommand = (command: string) => Promise<boolean>;

export interface LlmSetupDeps {
  checkCommand?: CheckCommand;
  /** Calls the chosen AI once before saving (a wrong key or a stopped local server is caught here); none = no check. */
  checkProvider?: (provider: LlmProviderPreset, key: string | undefined, model?: string) => Promise<LlmCheck>;
  /** Install and sign in to a subscription CLI right here; without it setup only checks the command exists. */
  connectCli?: CliConnectDeps;
}

const CLI_NOTICE: Record<'ko' | 'en', readonly string[]> = {
  ko: [
    '이 Mac에 로그인된 구독으로 동작해요. API 키는 필요하지 않아요.',
    '사용량 한도와 공급사의 약관은 사용자가 직접 지켜야 해요.',
    '먼저 CLI를 설치하고 한 번 로그인해 두어야 해요.',
  ],
  en: [
    'Uses the subscription already logged in on this Mac. No API key is needed.',
    "Usage limits and the provider's terms are your responsibility.",
    'The CLI must be installed and logged in once before use.',
  ],
};

const MISSING_CLI: Record<'ko' | 'en', (command: string) => string> = {
  ko: (command) => `'${command}' 명령을 찾지 못했어요. 설치한 뒤 한 번 로그인해 주세요.`,
  en: (command) => `Could not find the command "${command}". Install it and log in once first.`,
};

/** One line under the highlighted choice: what you need and what it costs. */
const PRESET_HINTS: Readonly<Record<string, string>> = {
  anthropic: 'API 키가 필요해요 (console.anthropic.com). 쓴 만큼 요금이 나가요.',
  openai: 'API 키가 필요해요 (platform.openai.com). 쓴 만큼 요금이 나가요.',
  deepseek: 'API 키가 필요해요. 값이 싸지만 민감한 내용은 가린 뒤 보내요.',
  ollama: '이 맥에서 돌아가요. Ollama를 먼저 설치해야 하고 맥이 빨라야 해요.',
  'claude-cli': '이미 쓰는 Claude 구독으로 돌아가요. API 키는 필요 없어요.',
  'codex-cli': '이미 쓰는 ChatGPT/Codex 구독으로 돌아가요. API 키는 필요 없어요.',
};

const defaultCheckCommand: CheckCommand = async (command) => {
  try {
    const result = await nodeCliRunner(command, ['--version'], '', { timeoutMs: 5_000 });
    return result.code === 0;
  } catch {
    return false;
  }
};

function isCliPreset(preset: LlmPreset): boolean {
  return preset.providers.some((provider) => provider.kind === 'claude-cli' || provider.kind === 'codex-cli');
}

function defaultPresetIndex(existing: Config | undefined): number {
  if (existing === undefined) return 0;
  const ids = new Set(existing.llm.providers.map((provider) => provider.id));
  const index = LLM_PRESETS.findIndex((preset) => preset.providers.some((provider) => ids.has(provider.id)));
  return index >= 0 ? index : 0;
}

async function askApiKey(prompter: Prompter, preset: LlmPreset): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const key = (await prompter.secret(`${preset.label} API 키: `)).trim();
    if (key.length > 0) return key;
    prompter.say('API 키가 비어 있어요. 다시 입력해 주세요.');
  }
  // back to choosing the AI (another one, or a subscription CLI) instead of ending setup and losing the answers
  prompter.say('API 키 없이는 이 AI를 쓸 수 없어요. 다른 AI를 고르는 단계로 돌아갈게요.');
  throw new PromptBack();
}

export async function configureLlm(
  prompter: Prompter,
  secrets: SecretStore,
  existing?: Config,
  deps: LlmSetupDeps = {},
): Promise<LlmSetupResult> {
  const options = [
    ...LLM_PRESETS.map((preset) => ({ value: preset.id, label: preset.label, ...(PRESET_HINTS[preset.id] !== undefined ? { hint: PRESET_HINTS[preset.id] } : {}) })),
    { value: 'later', label: '나중에', hint: '앱의 더보기 › AI 연결하기에서도 할 수 있어요.' },
  ];
  const language = existing?.assistant.language ?? 'ko';
  let defaultIndex = defaultPresetIndex(existing);
  for (;;) {
    const choice = await prompter.choose('비서가 쓸 AI를 골라 주세요', options, defaultIndex);
    const preset = LLM_PRESETS.find((candidate) => candidate.id === choice);
    if (preset === undefined) return { providers: [], routes: [] };

    let key: string | undefined;
    if (preset.apiKeySecret !== undefined) key = await askApiKey(prompter, preset);
    if (!isCliPreset(preset) && deps.checkProvider !== undefined) {
      const provider = preset.providers[0];
      prompter.say('연결되는지 확인하는 중이에요…');
      const check = provider === undefined ? { ok: true as const } : await deps.checkProvider(provider, key, preset.routes[0]?.model);
      if (!check.ok) {
        prompter.say(check.reason);
        // the same AI again (a corrected key) is the first choice; another AI is one down
        defaultIndex = options.findIndex((option) => option.value === choice);
        continue;
      }
      prompter.say('✓ 연결됐어요.');
    }
    if (preset.apiKeySecret !== undefined && key !== undefined) await secrets.set(preset.apiKeySecret, key);

    if (isCliPreset(preset)) {
      for (const line of CLI_NOTICE[language]) prompter.say(line);
      const command = preset.providers.find((provider) => provider.command !== undefined)?.command;
      if (command !== undefined && deps.connectCli !== undefined) {
        const connected = await connectCli(prompter, deps.connectCli, command);
        if (connected === 'other') {
          defaultIndex = options.findIndex((option) => option.value === choice) + 1;
          continue;
        }
      } else if (command !== undefined) {
        const check = deps.checkCommand ?? defaultCheckCommand;
        if (!(await check(command))) prompter.say(MISSING_CLI[language](command));
      }
    }
    return presetResult(preset);
  }
}

function presetResult(preset: LlmPreset): LlmSetupResult {
  return {
    providers: preset.providers.map((provider) => ({ ...provider })),
    routes: preset.routes.map((route) => ({ ...route, tiers: [...route.tiers] })),
  };
}
