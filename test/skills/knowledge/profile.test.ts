import { describe, expect, it } from 'vitest';
import { knowledgeTexts } from '../../../src/skills/knowledge/locale.js';
import { profileSummary, reviewLines } from '../../../src/skills/knowledge/profile.js';
import { line, stored } from './helpers.js';

const texts = knowledgeTexts('ko');

function projectLine(topic: string, key: string, text: string, at = '2026-11-01T09:00:00+09:00') {
  return line({ area: 'project', topic, key, text, at });
}

describe('profileSummary', () => {
  it('joins the profile sections and only active projects', () => {
    const lines = [
      line({ area: 'profile', topic: 'role', key: 'role', text: '엔지니어' }),
      line({ area: 'profile', topic: 'org', key: 'org', text: 'AX' }),
      line({ area: 'profile', topic: 'interest', key: 'interest', text: '등산' }),
      projectLine('Alpha', 'status', '진행 중'),
      projectLine('Beta', 'status', '완료'),
      projectLine('C', 'purpose', '문서 정리'),
    ];

    expect(profileSummary(lines, texts, 600)).toBe(
      '하는 일: 엔지니어. 조직: AX. 관심사: 등산. 진행 중 프로젝트: Alpha, C',
    );
  });

  it('treats a project without a status line as active and caps the list at six', () => {
    const lines = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((name) => projectLine(name, 'purpose', '일'));

    expect(profileSummary(lines, texts, 600)).toBe('진행 중 프로젝트: A, B, C, D, E, F');
  });

  it('treats English status words as finished', () => {
    const lines = [projectLine('Old', 'status', 'archived'), projectLine('Live', 'status', 'in progress')];

    expect(profileSummary(lines, texts, 600)).toBe('진행 중 프로젝트: Live');
  });

  it('clips to maxChars with an ellipsis', () => {
    const lines = [line({ area: 'profile', topic: 'role', key: 'role', text: '아주 긴 설명'.repeat(40) })];

    const summary = profileSummary(lines, texts, 30);

    expect(summary?.length).toBeLessThanOrEqual(30);
    expect(summary?.endsWith('…')).toBe(true);
  });

  it('uses English labels and returns undefined with nothing to say', () => {
    const en = knowledgeTexts('en');
    const lines = [line({ area: 'profile', topic: 'role', key: 'role', text: 'engineer' })];

    expect(profileSummary(lines, en, 600)).toBe('What they do: engineer');
    expect(profileSummary([], texts, 600)).toBeUndefined();
  });
});

describe('reviewLines', () => {
  it('orders profile sections, then project purposes, and carries line ids', () => {
    const roleNew = stored({
      area: 'profile',
      topic: 'role',
      key: 'role',
      text: '새 역할',
      at: '2026-11-10T09:00:00+09:00',
    });
    const roleOld = stored({
      area: 'profile',
      topic: 'role',
      key: 'role-old',
      text: '옛 역할',
      at: '2026-11-01T09:00:00+09:00',
    });
    const org = stored({ area: 'profile', topic: 'org', key: 'org', text: 'AX' });
    const interest = stored({ area: 'profile', topic: 'interest', key: 'interest', text: '등산' });
    const other = stored({ area: 'profile', topic: 'misc', key: 'misc', text: '왼손잡이' });
    const purpose = stored({ area: 'project', topic: 'Acme', key: 'purpose', text: '결제 앱' });
    const otherPurpose = stored({ area: 'project', topic: 'C', key: 'purpose', text: '문서 정리' });

    const review = reviewLines(
      [org, purpose, roleOld, otherPurpose, roleNew, interest, other],
      texts,
    );

    expect(review.map((item) => item.text)).toEqual([
      '새 역할',
      '옛 역할',
      'AX',
      '등산',
      '왼손잡이',
      'Acme: 결제 앱',
      'C: 문서 정리',
    ]);
    expect(review[0]?.id).toBe(roleNew.id);
    expect(review[5]?.id).toBe(purpose.id);
  });

  it('skips projects with no purpose line', () => {
    const review = reviewLines([stored({ area: 'project', topic: 'NoPurpose', key: 'status', text: '진행 중' })], texts);

    expect(review).toEqual([]);
  });
});
