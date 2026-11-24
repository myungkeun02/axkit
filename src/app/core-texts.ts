import type { HealthTexts } from '../core/health/builtin.js';
import { enHealthTexts, koHealthTexts } from '../core/health/texts.js';

/** Owner-facing lines for the services the app builds itself (not a plugin, so no plugin locale). */
export interface CoreTexts {
  health: HealthTexts;
  digestTitle(count: number): string;
  overnightTitle(count: number): string;
  breakerPaused(feature: string, signature: string, count: number, untilDay: string): string;
  pauseEnding(feature: string, reason: string, untilDay: string): string;
  docsNeedReview(fact: string, titles: readonly string[]): string;
}

const ko: CoreTexts = {
  health: koHealthTexts,
  digestTitle: (count) => `오늘 알림이 많아 ${count}건을 한 번에 모았어요.`,
  overnightTitle: (count) => `밤사이 소식 ${count}건이에요.`,
  breakerPaused: (feature, signature, count, untilDay) =>
    `'${feature}' 기능이 같은 이유(${signature})로 ${count}번 연달아 실패해서 ${untilDay}까지 멈췄어요. 고친 뒤 다시 켜 주세요.`,
  pauseEnding: (feature, reason, untilDay) =>
    `'${feature}' 일시정지가 ${untilDay}에 끝나요 (이유: ${reason}). 계속 멈춰 둘지 알려 주세요.`,
  docsNeedReview: (fact, titles) =>
    `'${fact}' 사실이 끝났어요. 이 사실에 기댄 문서 ${titles.length}개를 다시 확인해 주세요: ${titles.join(', ')}`,
};

const en: CoreTexts = {
  health: enHealthTexts,
  digestTitle: (count) => `A busy day: ${count} notices folded into one.`,
  overnightTitle: (count) => `Overnight: ${count} notices.`,
  breakerPaused: (feature, signature, count, untilDay) =>
    `'${feature}' failed ${count} times in a row (${signature}), so it is paused until ${untilDay}. Turn it back on once fixed.`,
  pauseEnding: (feature, reason, untilDay) =>
    `The pause on '${feature}' ends on ${untilDay} (reason: ${reason}). Tell me if it should stay paused.`,
  docsNeedReview: (fact, titles) =>
    `'${fact}' no longer holds. ${titles.length} documents relied on it; please check: ${titles.join(', ')}`,
};

export function coreTexts(language: string): CoreTexts {
  return language === 'en' ? en : ko;
}
