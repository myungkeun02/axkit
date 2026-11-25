import { describe, expect, it } from 'vitest';
import type { Activity } from '../../../src/skills/onboarding/activity.js';
import { signatureOf } from '../../../src/skills/onboarding/activity.js';
import type { CachedSummary } from '../../../src/skills/onboarding/cache.js';
import { findRecurring, normalizeTitle } from '../../../src/skills/onboarding/recurring.js';
import { codeProposals, proposeRoutines } from '../../../src/skills/onboarding/routine-proposals.js';
import { onboardingTexts } from '../../../src/skills/onboarding/locale.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { BehaviorLlm } from './helpers.js';

const NOW = new Date('2026-11-25T09:00:00+09:00');
const DAY = 24 * 60 * 60 * 1000;

function activity(partial: Partial<Activity>): Activity {
  return { mails: [], signatures: [], recipients: new Map(), events: [], ownerEmails: [], ...partial };
}

/** Mondays 10:00 KST going back `weeks` weeks. */
function mondays(weeks: number): string[] {
  const last = Date.parse('2026-11-23T10:00:00+09:00');
  return Array.from({ length: weeks }, (_, index) => new Date(last - index * 7 * DAY).toISOString());
}

function file(title: string, modifiedAt: string): CachedSummary {
  return { stamp: 's', kind: 'drive', path: `Drive/${title}`, title, modifiedAt, summary: title, keywords: [] };
}

describe('normalizeTitle', () => {
  it('drops dates, weeks, versions and numbers but keeps the words', () => {
    expect(normalizeTitle('[주간보고] 2026년 11월 3주차_v2.docx')).toBe('주간보고');
    expect(normalizeTitle('Re: 주간보고 11/17')).toBe('주간보고');
    expect(normalizeTitle('2026-10 월말 결산.xlsx')).toBe('월말 결산');
    expect(normalizeTitle('20261103')).toBe('');
  });
});

describe('findRecurring', () => {
  it('finds a weekly meeting in the calendar with its day and time', () => {
    const events = mondays(10).map((start) => ({ title: '주간 회의', start, allDay: false, attendees: [] }));
    const found = findRecurring({ activity: activity({ events }), summaries: [] }, NOW, 'Asia/Seoul', true);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ source: 'calendar', count: 10, schedule: { kind: 'weekly', day: 'mon', at: '10:00' } });
    expect(found[0]?.evidence).toBe("캘린더 '주간 회의' 10번 · 매주 월 10:00");
  });

  it('finds a monthly closing from files made near each month end', () => {
    const summaries = ['2026-07-31', '2026-08-29', '2026-09-30', '2026-10-31'].map((day) => file(`${day.slice(0, 7)} 월말 결산.xlsx`, `${day}T08:00:00Z`));
    const found = findRecurring({ summaries }, NOW, 'Asia/Seoul', true);
    expect(found[0]).toMatchObject({ source: 'file', schedule: { kind: 'monthly', day: -1 } });
    expect(found[0]?.rhythm).toBe('매월 말일');
  });

  it('finds a report the owner sends every Friday', () => {
    const last = Date.parse('2026-11-20T17:00:00+09:00');
    const mails = Array.from({ length: 6 }, (_, index) => ({ from: 'me@a.co', subject: `[주간보고] ${11 - index}월 주차`, at: new Date(last - index * 7 * DAY).toISOString(), sent: true }));
    const found = findRecurring({ activity: activity({ mails }), summaries: [] }, NOW, 'Asia/Seoul', true);
    expect(found[0]).toMatchObject({ source: 'sent', schedule: { kind: 'weekly', day: 'fri' } });
  });

  it('ignores one-off work, the same file seen three times and patterns that stopped long ago', () => {
    const events = [{ title: '킥오프', start: '2026-11-10T10:00:00+09:00', allDay: false, attendees: [] }];
    const same = [file('기획서.docx', '2026-11-01T00:00:00Z'), file('기획서.docx', '2026-11-08T00:00:00Z'), file('기획서.docx', '2026-11-15T00:00:00Z')];
    const old = ['2025-01-06', '2025-01-13', '2025-01-20', '2025-01-27'].map((day) => ({ title: '옛 회의', start: `${day}T10:00:00+09:00`, allDay: false, attendees: [] }));
    expect(findRecurring({ activity: activity({ events: [...events, ...old] }), summaries: same }, NOW, 'Asia/Seoul', true)).toEqual([]);
  });
});

describe('routine proposals', () => {
  const found = findRecurring({ activity: activity({ events: mondays(8).map((start) => ({ title: '주간 회의', start, allDay: false, attendees: [] })) }), summaries: [] }, NOW, 'Asia/Seoul', true);

  it('keeps the schedule and evidence code found and lets the model word and assign them', async () => {
    const llm = new BehaviorLlm(() => JSON.stringify({ routines: [{ ref: 'C1', keep: true, title: '주간 회의 준비', instruction: '안건을 정리해 줘', team: 'T1', schedule: { kind: 'daily', at: '03:00' } }] }));
    const proposals = await proposeRoutines({ llm, log: silentLogger, texts: onboardingTexts('ko'), korean: true }, found, [{ company: '에이컴퍼니', name: '마케팅팀' }]);
    expect(proposals).toEqual([
      { title: '주간 회의 준비', instruction: '안건을 정리해 줘', schedule: { kind: 'weekly', day: 'mon', at: '10:00' }, team: '마케팅팀', company: '에이컴퍼니', evidence: ["캘린더 '주간 회의' 8번 · 매주 월 10:00"] },
    ]);
  });

  it('falls back to plain routines without a model', async () => {
    const llm = new BehaviorLlm(() => {
      throw new Error('down');
    });
    const proposals = await proposeRoutines({ llm, log: silentLogger, texts: onboardingTexts('ko'), korean: true }, found, []);
    expect(proposals).toEqual(codeProposals(found, true));
    expect(proposals[0]?.title).toBe('주간 회의 준비');
  });
});

describe('signatureOf', () => {
  it('reads the lines above the quoted part, with phone numbers masked', () => {
    const body = '안녕하세요.\n자료 보냅니다.\n\n김민수 팀장\n에이컴퍼니 마케팅팀\n010-1234-5678\n\n2026년 11월 3일 (월) 오후 2:00, 이지은 님이 작성:\n> 이전 메일';
    const text = signatureOf(body);
    expect(text).toContain('김민수 팀장 / 에이컴퍼니 마케팅팀');
    expect(text).not.toContain('1234-5678');
  });
});
