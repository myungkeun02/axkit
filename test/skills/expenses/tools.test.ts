import { describe, expect, it } from 'vitest';
import type { SpendEntry } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { ToolOutcome } from '../../../src/core/tools/types.js';
import { FakeConfirmer } from '../../support/context.js';
import type { CandidatesOutput, DraftClaimOutput, SummaryOutput } from '../../../src/skills/expenses/tools-claims.js';
import { FakeComposer, entry, rule, setup } from './helpers.js';

const CONFIG = { rules: [rule({ id: 'lunch', name: '평일 점심 식대', categories: ['food'] })] };
const NOV_ENTRY = entry({ id: 'nov1', amount: 5_000, at: '2026-11-03T12:00:00+09:00' });

async function done<O>(outcome: ToolOutcome<O>): Promise<O> {
  expect(outcome.status).toBe('done');
  return (outcome as { status: 'done'; output: O }).output;
}

describe('expenses rule tools', () => {
  it('lists config rules and rules the owner added', async () => {
    const { ctx } = await setup({ config: CONFIG });

    await done(await ctx.tools.execute('expenses.add_rule', { id: 'ai_tools', name: '업무용 AI', categories: ['ai'] }));
    const output = await done(
      await ctx.tools.execute('expenses.list_rules', {}),
    ) as { rules: { id: string; source: string }[] };

    expect(output.rules.map((value) => [value.id, value.source])).toEqual([
      ['lunch', 'config'],
      ['ai_tools', 'owner'],
    ]);
  });

  it('rejects a duplicate id or a time window that crosses midnight', async () => {
    const { ctx } = await setup({ config: CONFIG });

    const duplicate = await ctx.tools.execute('expenses.add_rule', { id: 'lunch', name: 'dup' });
    expect(duplicate.status).toBe('failed');
    expect(duplicate.status === 'failed' ? duplicate.error : '').toContain('같은 id');

    const invalid = await ctx.tools.execute('expenses.add_rule', {
      id: 'bad_window',
      name: 'bad',
      timeFrom: '15:00',
      timeTo: '14:00',
    });
    expect(invalid.status).toBe('failed');
    expect(invalid.status === 'failed' ? invalid.error : '').toContain('규칙을 확인');
  });

  it('asks for approval before deleting a rule and never deletes config rules', async () => {
    const confirmer = new FakeConfirmer('approved');
    const { ctx } = await setup({ config: CONFIG, confirmer });

    const outcome = await ctx.tools.execute('expenses.remove_rule', { id: 'lunch' });

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.error : '').toContain('설정 파일에서 지워 주세요');
    expect(confirmer.requests).toHaveLength(1);
    expect(confirmer.requests[0]?.effects).toEqual(['delete']);
    expect(confirmer.requests[0]?.toolName).toBe('expenses.remove_rule');
  });

  it('deletes an owner rule when approved', async () => {
    const confirmer = new FakeConfirmer('approved');
    const { ctx } = await setup({ confirmer });
    await done(await ctx.tools.execute('expenses.add_rule', { id: 'owner_rule', name: '내 규칙' }));

    const outcome = await ctx.tools.execute('expenses.remove_rule', { id: 'owner_rule' });
    expect(outcome.status).toBe('done');
    const listed = await done(await ctx.tools.execute('expenses.list_rules', {})) as { rules: unknown[] };
    expect(listed.rules).toHaveLength(0);
  });

  it('keeps the rule when the owner denies the approval', async () => {
    const confirmer = new FakeConfirmer('denied');
    const { ctx } = await setup({ confirmer });
    await done(await ctx.tools.execute('expenses.add_rule', { id: 'owner_rule', name: '내 규칙' }));

    const outcome = await ctx.tools.execute('expenses.remove_rule', { id: 'owner_rule' });
    expect(outcome.status).toBe('denied');
    const listed = await done(await ctx.tools.execute('expenses.list_rules', {})) as { rules: unknown[] };
    expect(listed.rules).toHaveLength(1);
  });
});

describe('expenses claim tools', () => {
  it('defaults candidates to the current month and accepts another month', async () => {
    const entries: SpendEntry[] = [
      NOV_ENTRY,
      entry({ id: 'oct1', at: '2026-10-10T12:00:00+09:00' }),
    ];
    const { ctx, reader } = await setup({ config: CONFIG, entries });

    const current = await done(await ctx.tools.execute('expenses.candidates', {})) as CandidatesOutput;
    expect(current.month).toBe('2026-11');
    expect(current.candidates.map((item) => item.entryId)).toEqual(['nov1']);
    expect(reader.ranges[0]?.from.getTime()).toBe(new Date('2026-11-01T00:00:00+09:00').getTime());

    const october = await done(
      await ctx.tools.execute('expenses.candidates', { month: '2026-10' }),
    ) as CandidatesOutput;
    expect(october.month).toBe('2026-10');
    expect(october.candidates.map((item) => item.entryId)).toEqual(['oct1']);
  });

  it('remembers a merchant decision so later entries are candidates', async () => {
    const entries: SpendEntry[] = [
      entry({ id: 'oct1', at: '2026-10-10T12:00:00+09:00' }),
      entry({ id: 'nov1', at: '2026-11-03T12:00:00+09:00' }),
    ];
    const { ctx, kv } = await setup({ config: CONFIG, entries });

    const marked = await done(
      await ctx.tools.execute('expenses.mark', { entryId: 'oct1', decision: 'claim' }),
    ) as { remembered: boolean };
    expect(marked.remembered).toBe(true);
    expect(await kv.get('merchant')).toBeDefined();

    const report = await done(
      await ctx.tools.execute('expenses.candidates', { month: '2026-11' }),
    ) as CandidatesOutput;
    expect(report.candidates[0]?.entryId).toBe('nov1');
    expect(report.candidates[0]?.reason).toBe('merchant_decision');
  });

  it('marks an entry personal without touching the merchant when remember is false', async () => {
    const { ctx, kv } = await setup({ config: CONFIG, entries: [NOV_ENTRY] });

    const marked = await done(
      await ctx.tools.execute('expenses.mark', { entryId: 'nov1', decision: 'personal', remember: false }),
    ) as { remembered: boolean };
    expect(marked.remembered).toBe(false);
    expect(await kv.get('merchant')).toBeUndefined();

    const report = await done(
      await ctx.tools.execute('expenses.candidates', {}),
    ) as CandidatesOutput;
    expect(report.candidates).toHaveLength(0);
  });

  it('summarizes per-rule totals and the grand total', async () => {
    const entries = [
      NOV_ENTRY,
      entry({ id: 'nov2', amount: 4_000, at: '2026-11-12T12:00:00+09:00' }),
    ];
    const { ctx } = await setup({
      config: { rules: [rule({ id: 'lunch', name: '평일 점심 식대', categories: ['food'], monthlyCap: 8_000 })] },
      entries,
    });

    const summary = await done(
      await ctx.tools.execute('expenses.summary', { month: '2026-11' }),
    ) as SummaryOutput;

    expect(summary.grandTotal).toBe(9_000);
    expect(summary.candidateCount).toBe(2);
    expect(summary.totals).toEqual([
      { ruleId: 'lunch', name: '평일 점심 식대', count: 2, total: 9_000, cap: 8_000, overCap: true },
    ]);
  });

  it('drafts the claim mail with the configured recipients', async () => {
    const composer = new FakeComposer('draft-1');
    const { ctx } = await setup({
      config: {
        ...CONFIG,
        claimTo: ['team@example.com'],
        claimCc: ['boss@example.com'],
        companyLabel: '예시회사',
      },
      entries: [NOV_ENTRY],
      capabilities: { [Contracts.mailCompose.id]: composer },
    });

    const output = await done(
      await ctx.tools.execute('expenses.draft_claim_mail', { month: '2026-11' }),
    ) as DraftClaimOutput;

    expect('draftId' in output).toBe(true);
    if (!('draftId' in output)) throw new Error('expected a draft');
    expect(output.draftId).toBe('draft-1');
    expect(output.note).toBe('아직 보내지 않았어요. 보내려면 승인이 필요해요.');
    expect(output.subject).toBe('예시회사 2026년 11월 경비 청구');
    expect(output.body).toContain('11/03  카페 예시  5,000원  평일 점심 식대');
    expect(composer.drafts).toHaveLength(1);
    expect(composer.drafts[0]?.to).toEqual(['team@example.com']);
    expect(composer.drafts[0]?.cc).toEqual(['boss@example.com']);
  });

  it('returns the mail text when no composer is connected', async () => {
    const { ctx } = await setup({ config: { ...CONFIG, claimTo: ['team@example.com'] }, entries: [NOV_ENTRY] });

    const output = await done(
      await ctx.tools.execute('expenses.draft_claim_mail', { month: '2026-11' }),
    ) as DraftClaimOutput;

    expect('draftId' in output).toBe(false);
    expect('status' in output).toBe(false);
    if ('draftId' in output || 'status' in output) throw new Error('expected text');
    expect(output.subject).toContain('2026년 11월 경비 청구');
    expect(output.body).toContain('합계: 5,000원');
  });

  it('reports no_recipient when the config and the call have no addresses', async () => {
    const { ctx } = await setup({ config: CONFIG, entries: [NOV_ENTRY] });

    const output = await done(
      await ctx.tools.execute('expenses.draft_claim_mail', { month: '2026-11' }),
    ) as DraftClaimOutput;

    if (!('status' in output)) throw new Error('expected no_recipient');
    expect(output.status).toBe('no_recipient');
    expect((output as { hint: string }).hint).toContain('주소가 없어요');
  });

  it('lets the call override the configured recipients', async () => {
    const composer = new FakeComposer();
    const { ctx } = await setup({
      config: { ...CONFIG, claimTo: ['team@example.com'] },
      entries: [NOV_ENTRY],
      capabilities: { [Contracts.mailCompose.id]: composer },
    });

    await done(
      await ctx.tools.execute('expenses.draft_claim_mail', {
        month: '2026-11',
        to: ['other@example.com'],
      }),
    );
    expect(composer.drafts[0]?.to).toEqual(['other@example.com']);
  });

  it('describes the draft with recipients, subject and the last known total', async () => {
    const { ctx, registry } = await setup({
      config: { ...CONFIG, claimTo: ['team@example.com'], companyLabel: '예시회사' },
      entries: [NOV_ENTRY],
    });

    const tool = registry.get('expenses.draft_claim_mail');
    expect(tool?.describe?.({ month: '2026-11' })).toContain('합계: 계산 전');

    await done(await ctx.tools.execute('expenses.summary', { month: '2026-11' }));
    const text = tool?.describe?.({ month: '2026-11' }) ?? '';
    expect(text).toContain('받는 사람: team@example.com');
    expect(text).toContain('예시회사 2026년 11월 경비 청구');
    expect(text).toContain('합계: 5,000원');
  });

  it('reports an error when spending is not connected', async () => {
    const { ctx } = await setup({ config: CONFIG, withSpend: false });
    const outcome = await ctx.tools.execute('expenses.candidates', {});
    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.error : '').toContain('연결되지 않았어요');
  });
});
