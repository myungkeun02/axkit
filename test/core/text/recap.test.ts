import { describe, expect, it } from 'vitest';
import { capRecap, renderRecap } from '../../../src/core/text/recap.js';

describe('recap', () => {
  it('clips, dedupes and never invents a next action', () => {
    const recap = capRecap({ done: ['  좌석 조회  ', '좌석 조회', ''], nextAction: '   ' });
    expect(recap).toEqual({ done: ['좌석 조회'], decisions: [], constraints: [], remaining: [], unverified: [], nextAction: null });
    expect(renderRecap(recap)).toBe('한 일: 좌석 조회\n다음 행동: 없음');
  });

  it('cuts done first and keeps unverified caveats last', () => {
    const long = (prefix: string) => Array.from({ length: 8 }, (_, i) => `${prefix} ${i} ${'x'.repeat(250)}`);
    const recap = capRecap({ done: long('d'), remaining: long('r'), unverified: ['결제 완료는 확인 안 됨'] }, 2000);
    expect(new TextEncoder().encode(JSON.stringify(recap)).length).toBeLessThanOrEqual(2000);
    expect(recap.done).toEqual([]);
    expect(recap.unverified).toEqual(['결제 완료는 확인 안 됨']);
  });
});
