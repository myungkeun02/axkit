import type { Config } from '../core/config/schema.js';
import { chooseOrType } from './prompt-kit.js';
import type { Prompter } from './prompter.js';

export interface BriefingChoice {
  enabled: boolean;
  at?: string;
}

export interface ScheduleAnswers {
  briefing: BriefingChoice;
  quietHours?: { from: string; to: string };
  confirmWrites: boolean;
}

export interface ScheduleStepDeps {
  prompter: Prompter;
  existing?: Config;
}

const BRIEFING_TIMES = ['07:00', '08:00', '09:00'] as const;

const QUIET_OPTIONS = [
  { value: '23-07', label: '23:00–07:00', from: '23:00', to: '07:00' },
  { value: '22-08', label: '22:00–08:00', from: '22:00', to: '08:00' },
  { value: '00-09', label: '00:00–09:00', from: '00:00', to: '09:00' },
  { value: 'none', label: '없음', from: undefined, to: undefined },
] as const;

const HHMM = /^([01]?\d|2[0-3]):?([0-5]\d)$/;

/** "7:30", "0730" → "07:30"; undefined when it is not a time. */
export function normalizeTime(value: string): string | undefined {
  const match = HHMM.exec(value.trim());
  if (match === null) return undefined;
  return `${(match[1] ?? '').padStart(2, '0')}:${match[2] ?? '00'}`;
}

/** "22:30-06:00" or "22:30~06:00". */
export function parseQuiet(value: string): { from: string; to: string } | undefined {
  const parts = value.split(/\s*[-~–]\s*/);
  if (parts.length !== 2) return undefined;
  const from = normalizeTime(parts[0] ?? '');
  const to = normalizeTime(parts[1] ?? '');
  return from === undefined || to === undefined || from === to ? undefined : { from, to };
}

function briefingIndex(existing: Config | undefined): number {
  const settings = existing?.plugins['skill.briefing'];
  if (settings?.enabled === false) return BRIEFING_TIMES.length;
  const at = settings?.['at'];
  const index = BRIEFING_TIMES.findIndex((time) => time === at);
  return index >= 0 ? index : 1;
}

function quietIndex(existing: Config | undefined): number {
  const quiet = existing?.assistant.quietHours;
  if (quiet === undefined) return existing === undefined ? 0 : QUIET_OPTIONS.length - 1;
  const index = QUIET_OPTIONS.findIndex((option) => option.from === quiet.from && option.to === quiet.to);
  return index >= 0 ? index : QUIET_OPTIONS.length - 1;
}

async function askBriefing(prompter: Prompter, existing: Config | undefined): Promise<BriefingChoice> {
  const current = existing?.plugins['skill.briefing']?.['at'];
  const custom = typeof current === 'string' && !BRIEFING_TIMES.some((time) => time === current) ? current : undefined;
  const options = [
    ...BRIEFING_TIMES.map((time) => ({ value: time, label: time })),
    ...(custom !== undefined ? [{ value: custom, label: `${custom} (지금 설정)` }] : []),
    { value: 'off', label: '보내지 않기' },
  ];
  const choice = await chooseOrType(prompter, '아침 브리핑(오늘 일정·할 일 요약)은 몇 시에 보낼까요?', options, {
    defaultIndex: existing?.plugins['skill.briefing']?.enabled === false ? options.length - 1 : custom !== undefined ? BRIEFING_TIMES.length : briefingIndex(existing),
    type: { label: '다른 시각 직접 입력', placeholder: '07:30', validate: (value) => (normalizeTime(value) === undefined ? '07:30처럼 적어 주세요.' : undefined) },
  });
  if (choice === 'off') return { enabled: false };
  const at = normalizeTime(choice);
  return at === undefined ? { enabled: false } : { enabled: true, at };
}

async function askQuietHours(prompter: Prompter, existing: Config | undefined): Promise<{ from: string; to: string } | undefined> {
  const current = existing?.assistant.quietHours;
  const known = current === undefined || QUIET_OPTIONS.some((option) => option.from === current.from && option.to === current.to);
  const options = [
    ...QUIET_OPTIONS.filter((option) => option.value !== 'none').map((option) => ({ value: option.value, label: option.label })),
    ...(!known && current !== undefined ? [{ value: `${current.from}-${current.to}`, label: `${current.from}–${current.to} (지금 설정)` }] : []),
    { value: 'none', label: '없음 — 언제든 바로 알려 주기' },
  ];
  const choice = await chooseOrType(prompter, '조용한 시간 (급하지 않은 알림은 모았다가 끝나면 보내요)', options, {
    defaultIndex: known ? Math.min(quietIndex(existing), options.length - 1) : QUIET_OPTIONS.length - 1,
    type: { label: '다른 시간 직접 입력', placeholder: '22:30-06:30', validate: (value) => (parseQuiet(value) === undefined ? '22:30-06:30처럼 적어 주세요.' : undefined) },
  });
  if (choice === 'none') return undefined;
  const preset = QUIET_OPTIONS.find((candidate) => candidate.value === choice);
  if (preset !== undefined && preset.from !== undefined && preset.to !== undefined) return { from: preset.from, to: preset.to };
  return parseQuiet(choice);
}

/**
 * Morning briefing and quiet hours. What needs a confirmation is not asked on day one: sends, payments and deletes
 * always do, and the rest keeps what was set (the owner can tighten it later in config.json).
 */
export async function askSchedule(deps: ScheduleStepDeps): Promise<ScheduleAnswers> {
  const { prompter, existing } = deps;
  const briefing = await askBriefing(prompter, existing);
  const quietHours = await askQuietHours(prompter, existing);
  return {
    briefing,
    ...(quietHours !== undefined ? { quietHours } : {}),
    confirmWrites: existing?.policy.confirmWrites ?? false,
  };
}
