import { describe, expect, it } from 'vitest';
import { intakeTexts, reportTexts } from '../../../src/skills/company/locale-intake.js';
import type { CloseReason, TaskStatus } from '../../../src/skills/company/types.js';
import { task } from './helpers.js';

const STATUSES: readonly TaskStatus[] = [
  'awaiting_accept',
  'queued',
  'planning',
  'running',
  'review',
  'awaiting_owner',
  'done',
  'failed',
  'closed',
];

const REASONS: readonly CloseReason[] = [
  'stale',
  'owner_wait_expired',
  'declined',
  'review_failed',
  'failed',
  'cancelled',
];

describe('intakeTexts', () => {
  it('uses the short Korean refusal examples', () => {
    const texts = intakeTexts('ko');

    expect(texts.companyFull(6)).toBe(
      '지금 회사 일이 6건 열려 있어 더 받지 않을게요. 끝나거나 닫히면 다시 맡겨 주세요.',
    );
    expect(texts.teamFull('개발', 2)).toBe('개발 팀은 이미 2건을 하고 있어요.');
    expect(texts.unknownTeam(['개발', '마케팅'])).toBe(
      "어느 팀 일인지 모르겠어요. 팀: 개발, 마케팅 — '@dev 할 일'처럼 적어 주세요.",
    );
  });

  it('speaks English when asked', () => {
    const texts = intakeTexts('en');

    expect(texts.language).toBe('en');
    expect(texts.accepted(task({ id: 'aaaaaaaa', title: 'Fix login' }))).toBe('Taken: Fix login');
    expect(texts.unknownTeam([])).toBe('There are no company teams yet. Set them up first.');
  });
});

describe('reportTexts', () => {
  it('has a short Korean label for every status and close reason', () => {
    const texts = reportTexts('ko');
    const labels = STATUSES.map((status) => texts.statusLabel(status));
    const reasons = REASONS.map((reason) => texts.closeReasonLabel(reason));

    expect(labels).toEqual([
      '대기 확인',
      '대기',
      '계획 중',
      '진행 중',
      '검토 중',
      '결재 대기',
      '완료',
      '실패',
      '닫힘',
    ]);
    expect(reasons).toEqual(['오래 멈춤', '결재 기한 지남', '거절', '검토 통과 못 함', '실패', '취소']);
  });

  it('formats the title, choice labels and backlog line', () => {
    const texts = reportTexts('ko');

    expect(texts.title('2026-11-18', { done: 1, failed: 2, closed: 3, open: 4 })).toBe(
      '회사 일 2026-11-18 — 완료 1 · 실패 2 · 닫힘 3 · 열림 4',
    );
    expect(texts.acceptLabel('메일 정리')).toBe('받기 메일 정리');
    expect(texts.dropLabel('메일 정리')).toBe('거절 메일 정리');
    expect(
      texts.backlogLine({
        open: 2,
        stale: 1,
        createdInWeek: 5,
        doneInWeek: 2,
        autoClosedInWeek: 1,
        openLimit: 6,
      }),
    ).toContain('열린 일 2/6');
  });

  it('returns English labels for every status and close reason', () => {
    const texts = reportTexts('en');

    expect(texts.statusLabel('awaiting_accept')).toBe('Needs a yes');
    expect(texts.closeReasonLabel('owner_wait_expired')).toBe('Approval expired');
    expect(STATUSES.every((status) => texts.statusLabel(status) !== '')).toBe(true);
    expect(REASONS.every((reason) => texts.closeReasonLabel(reason) !== '')).toBe(true);
  });
});
