import type { Config } from '../core/config/schema.js';
import type { Prompter } from './prompter.js';

export interface AssistantAnswers {
  name: string;
  tone: 'polite' | 'formal' | 'casual';
  ownerName?: string;
  language: 'ko' | 'en';
  timezone: string;
}

export interface AssistantStepDeps {
  prompter: Prompter;
  existing?: Config;
  detectTimezone?: () => string;
}

const TONES = [
  { value: 'polite', label: '해요체', hint: '친근한 존댓말 — "오늘 일정은 두 개예요"' },
  { value: 'formal', label: '합쇼체', hint: '격식 있는 존댓말 — "오늘 일정은 두 개입니다"' },
  { value: 'casual', label: '반말', hint: '편하게 — "오늘 일정 두 개야"' },
] as const;

const FALLBACK_TIMEZONE = 'Asia/Seoul';

function isTimeZone(value: string): boolean {
  if (value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function toneIndex(existing: Config | undefined): number {
  const index = TONES.findIndex((tone) => tone.value === existing?.assistant.tone);
  return index >= 0 ? index : 0;
}

/**
 * Name, tone and what to call the owner. Language and time zone are not asked: Korean (or what was set before) and
 * this Mac's time zone; both can be changed in config.json.
 */
export async function askAssistant(deps: AssistantStepDeps): Promise<AssistantAnswers> {
  const { prompter, existing } = deps;

  const name = await prompter.text('비서 이름', {
    default: existing?.assistant.name ?? '비서',
    validate: (value) => {
      if (value.length === 0) return '이름을 입력해 주세요.';
      return value.length > 40 ? '40자 이하로 입력해 주세요.' : undefined;
    },
  });

  const toneChoice = await prompter.choose(
    '말투를 골라 주세요',
    TONES.map((tone) => ({ value: tone.value, label: tone.label, hint: tone.hint })),
    toneIndex(existing),
  );
  const tone = TONES.find((candidate) => candidate.value === toneChoice)?.value ?? 'polite';

  const existingOwnerName = existing?.assistant.ownerName;
  const ownerName = await prompter.text(
    '비서가 나를 부를 이름 (비워 두면 이름 없이 불러요)',
    existingOwnerName !== undefined && existingOwnerName.length > 0 ? { default: existingOwnerName } : undefined,
  );

  const language = existing?.assistant.language === 'en' ? 'en' : 'ko';
  const detected = deps.detectTimezone?.() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezone = existing?.assistant.timezone ?? (isTimeZone(detected) ? detected : FALLBACK_TIMEZONE);
  prompter.say(`시간대는 이 맥에 맞춰 ${timezone}(으)로 정했어요.`);

  return {
    name,
    tone,
    ...(ownerName.length > 0 ? { ownerName } : {}),
    language,
    timezone,
  };
}
