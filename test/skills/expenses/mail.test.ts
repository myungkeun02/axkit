import { describe, expect, it } from 'vitest';
import type { SpendEntry } from '../../../src/core/contracts/index.js';
import type { CandidateReport } from '../../../src/skills/expenses/candidates.js';
import { evaluateEntries } from '../../../src/skills/expenses/candidates.js';
import type { RuleConfig } from '../../../src/skills/expenses/config.js';
import { DecisionStore } from '../../../src/skills/expenses/decisions.js';
import { expensesTexts } from '../../../src/skills/expenses/locale.js';
import { buildClaimMail, stripCardNumbers } from '../../../src/skills/expenses/mail.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { entry } from './helpers.js';

const TZ = 'Asia/Seoul';
const KO = expensesTexts('ko');
const EN = expensesTexts('en');

async function report(entries: SpendEntry[], rules: RuleConfig[] = []): Promise<CandidateReport> {
  return evaluateEntries({
    entries,
    rules: rules.map((rule) => ({ rule, source: 'owner' as const })),
    decisions: new DecisionStore(new MapKeyValueStore()),
    timeZone: TZ,
    month: '2026-11',
    currency: 'KRW',
  });
}

describe('stripCardNumbers', () => {
  it('removes card-number runs and leaves the card company name', () => {
    expect(stripCardNumbers('카드 1234-5678-9012-3456 결제')).toBe('카드 결제');
    expect(stripCardNumbers('삼성카드 1234')).toBe('삼성카드');
    expect(stripCardNumbers('카페 예시')).toBe('카페 예시');
  });
});

describe('buildClaimMail', () => {
  it('writes the table, per-rule subtotals, grand total, cap flag and signature', async () => {
    const lunch: RuleConfig = { id: 'lunch', name: '평일 점심 식대', categories: ['food'], monthlyCap: 8_000 };
    const built = buildClaimMail(
      await report(
        [
          entry({ id: 'e1', amount: 5_000, at: '2026-11-03T12:00:00+09:00' }),
          entry({ id: 'e2', amount: 6_000, at: '2026-11-12T12:00:00+09:00' }),
        ],
        [lunch],
      ),
      { timeZone: TZ, companyLabel: '예시회사', ownerName: '지은', texts: KO },
    );

    expect(built.subject).toBe('예시회사 2026년 11월 경비 청구');
    expect(built.total).toBe(11_000);
    expect(built.candidateCount).toBe(2);
    expect(built.body).toBe(
      [
        '안녕하세요. 아래는 지난달 경비 청구 내역이에요.',
        '',
        '11/03  카페 예시  5,000원  평일 점심 식대',
        '11/12  카페 예시  6,000원  평일 점심 식대',
        '',
        '규칙별 합계',
        '- 평일 점심 식대: 2건 11,000원',
        '합계: 11,000원',
        '월 상한 초과: 평일 점심 식대 (상한 8,000원, 합계 11,000원)',
        '',
        '- 지은',
      ].join('\n'),
    );
  });

  it('never writes card numbers from a merchant name', async () => {
    const built = buildClaimMail(
      await report([entry({ merchant: '카드 1234-5678-9012-3456 결제' })], [
        { id: 'lunch', name: '평일 점심 식대' },
      ]),
      { timeZone: TZ, texts: KO },
    );

    expect(built.body).toContain('카드 결제');
    expect(built.body).not.toMatch(/\d{4}/);
    expect(built.body).not.toContain('3456');
  });

  it('renders English text and omits the signature when the owner name is not set', async () => {
    const built = buildClaimMail(
      await report([entry({ merchant: 'Cafe Example', at: '2026-11-03T12:00:00+09:00' })], [
        { id: 'lunch', name: 'Weekday lunch' },
      ]),
      { timeZone: TZ, texts: EN },
    );

    expect(built.subject).toBe('Expense claim — November 2026');
    expect(built.body).toContain('11/03  Cafe Example  5,000 KRW  Weekday lunch');
    expect(built.body).toContain('Total: 5,000 KRW');
    expect(built.body.trimEnd().split('\n').at(-1)).toBe('Total: 5,000 KRW');
  });

  it('says there is nothing to claim for an empty month', async () => {
    const built = buildClaimMail(await report([]), { timeZone: TZ, texts: KO });
    expect(built.body).toContain('청구할 항목이 없어요.');
    expect(built.total).toBe(0);
    expect(built.body).not.toContain('규칙별 합계');
  });
});
