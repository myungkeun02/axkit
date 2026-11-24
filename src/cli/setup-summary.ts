import type { Config } from '../core/config/schema.js';
import type { AssistantAnswers } from './setup-assistant.js';
import { appNextSteps, channelLabel } from './setup-channel.js';
import type { GoogleStepResult } from './setup-google.js';
import type { ScheduleAnswers } from './setup-schedule.js';
import type { SummaryRow } from './style.js';

/** The end screen of `ax-kit setup`: what is on, what is off, and what to do next. */

export const TONE_LABELS: Record<AssistantAnswers['tone'], string> = {
  polite: '해요체',
  formal: '합쇼체',
  casual: '반말',
};

export interface SetupOutcome {
  config: Config;
  configFile: string;
  /** The AI preset's label, or undefined when it was left for later. */
  ai?: string;
  /** Only for paid APIs. */
  dailyUsd?: number;
  google: GoogleStepResult;
  schedule: ScheduleAnswers;
  /** undefined when the step was not offered. */
  firstLook?: 'now' | 'later' | 'off';
  service: 'installed' | 'failed' | 'later';
  /** Apps paired or ready in the last step; undefined when the step did not run. */
  apps?: readonly string[];
}

export function googleLabel(google: GoogleStepResult): string {
  const connected = [
    ...(google.calendar === true ? ['캘린더'] : []),
    ...(google.gmail === true ? ['Gmail'] : []),
    ...(google.drive === true ? ['Drive'] : []),
    ...Object.entries({ 'connector.google-docs': 'Docs', 'connector.google-sheets': 'Sheets', 'connector.google-tasks': 'Tasks', 'connector.google-contacts': '주소록' })
      .filter(([id]) => google.workspace?.[id]?.['enabled'] === true)
      .map(([, label]) => label),
  ];
  return connected.length > 0 ? connected.join(', ') : '연결 안 함';
}

function firstLookLabel(value: SetupOutcome['firstLook']): string {
  if (value === 'now') return '시작하면 바로 해요';
  if (value === 'later') return '나중에 (대화창에서 "처음 알아보기")';
  return '하지 않아요';
}

export function summaryRows(outcome: SetupOutcome): SummaryRow[] {
  const { config, schedule } = outcome;
  const quiet = schedule.quietHours;
  const googleOn = outcome.google.calendar === true || outcome.google.gmail === true;
  const rows: SummaryRow[] = [
    { label: '비서', value: `${config.assistant.name} · ${TONE_LABELS[config.assistant.tone]} · ${config.assistant.timezone}` },
    { label: 'AI', value: outcome.ai ?? '나중에 연결', on: outcome.ai !== undefined },
  ];
  if (outcome.dailyUsd !== undefined) rows.push({ label: 'AI 예산', value: `하루 $${outcome.dailyUsd} · 한 달 최대 $${outcome.dailyUsd * 20}` });
  rows.push({ label: '대화', value: channelLabel(config.channel), on: true });
  if (outcome.apps !== undefined) {
    const names: Record<string, string> = { ios: '아이폰', android: '안드로이드', 'this-mac': '이 맥 앱', 'other-mac': '다른 맥 앱' };
    // a QR or a one-line install shown is not a connection yet: the app finishes it on its side
    rows.push({ label: '앱 연결', value: outcome.apps.length > 0 ? `${outcome.apps.map((device) => names[device] ?? device).join(' · ')} (앱에서 연결을 마치면 돼요)` : '나중에', on: outcome.apps.length > 0 });
  }
  if (config.channel !== 'app') rows.push({ label: '디스코드 주인', value: config.owner.discordUserId ?? '-', on: config.owner.discordUserId !== undefined });
  rows.push(
    { label: '메일·캘린더', value: googleOn ? googleLabel(outcome.google) : '나중에 연결', on: googleOn },
    { label: '아침 브리핑', value: schedule.briefing.enabled ? (schedule.briefing.at ?? '08:00') : '보내지 않아요', on: schedule.briefing.enabled },
    { label: '조용한 시간', value: quiet === undefined ? '없음' : `${quiet.from}–${quiet.to}`, on: quiet !== undefined },
  );
  if (outcome.firstLook !== undefined) rows.push({ label: '처음 알아보기', value: firstLookLabel(outcome.firstLook), on: outcome.firstLook !== 'off' });
  rows.push(
    { label: '늘 실행', value: outcome.service === 'installed' ? '맥이 켜져 있으면 늘 실행돼요' : '아직 (ax-kit service install)', on: outcome.service === 'installed' },
    { label: '선택 기능', value: '나중에 — 비서가 알맞은 걸 제안해요', on: false },
  );
  return rows;
}

export function nextSteps(outcome: SetupOutcome): string[] {
  const lines: string[] = [];
  if (outcome.config.channel !== 'discord' && (outcome.apps === undefined || outcome.apps.length === 0)) appNextSteps((line) => lines.push(line));
  if (outcome.ai === undefined) lines.push('AI 연결: 앱 더보기 › AI 연결하기, 또는 ax-kit setup');
  if (outcome.google.calendar !== true && outcome.google.gmail !== true) lines.push('메일·캘린더: ax-kit connect google');
  if (outcome.service === 'failed') lines.push('늘 실행 등록: ax-kit service install 로 다시 해 주세요');
  lines.push('기능 더 켜기: ax-kit setup features (쓰다 보면 비서가 알맞은 기능을 먼저 제안해요)');
  lines.push('상태 확인: ax-kit doctor');
  lines.push(`설정 파일: ${outcome.configFile}`);
  return lines;
}
