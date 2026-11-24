import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { MailDraft, SpendEntry } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { FakeConfirmer } from '../../support/context.js';
import type { SummaryOutput } from '../../../src/skills/expenses/tools-claims.js';
import {
  FakeComposer,
  FakeDrafter,
  FakeReplier,
  entry,
  incoming,
  rule,
  setup,
} from './helpers.js';

const DEC_NOW = new Date('2026-12-01T09:00:00+09:00');

const CONFIG = {
  claimTo: ['team@example.com'],
  companyLabel: '예시회사',
  rules: [
    rule({ id: 'lunch', name: '평일 점심 식대', categories: ['food'] }),
    rule({ id: 'ai_tools', name: '업무용 AI', categories: ['ai'] }),
  ],
};

const NOV_ENTRIES: SpendEntry[] = [
  entry({ id: 'n1', amount: 5_000, at: '2026-11-03T12:00:00+09:00' }),
  entry({ id: 'n2', amount: 5_000, at: '2026-11-12T12:00:00+09:00' }),
  entry({ id: 'ai1', merchant: 'OpenAI', category: 'ai', amount: 20_000, at: '2026-11-05T10:00:00+09:00' }),
];

async function findHandler(context: Awaited<ReturnType<typeof setup>>) {
  const handler = context.handlers.find((candidate) => candidate.id === 'expenses.choices');
  expect(handler).toBeDefined();
  return handler!;
}

describe('expenses.monthly job', () => {
  it('is registered at the configured time', async () => {
    const { scheduler } = await setup({ now: DEC_NOW, config: CONFIG, entries: NOV_ENTRIES });
    expect(scheduler.jobs.get('expenses.monthly')?.schedule).toEqual({ kind: 'daily', at: '09:00' });
  });

  it('reports the previous month with rule totals, grand total and unsure count', async () => {
    const { scheduler, notifier } = await setup({ now: DEC_NOW, config: CONFIG, entries: NOV_ENTRIES });

    await scheduler.run('expenses.monthly', DEC_NOW);

    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice?.kind).toBe('expenses.monthly');
    expect(notice?.dedupeKey).toBe('expenses.monthly:2026-11');
    expect(notice?.text).toContain('2026년 11월 경비 청구 요약');
    expect(notice?.text).toContain('- 평일 점심 식대: 2건 10,000원');
    expect(notice?.text).toContain('합계: 10,000원');
    expect(notice?.text).toContain('확인 필요 1건');
    expect(notice?.choices).toEqual([
      { id: 'exp.review:2026-11', label: '후보 확인' },
      { id: 'exp.draft:2026-11', label: '청구 메일 초안' },
    ]);
  });

  it('runs once per month', async () => {
    const { scheduler, notifier } = await setup({ now: DEC_NOW, config: CONFIG, entries: NOV_ENTRIES });

    await scheduler.run('expenses.monthly', DEC_NOW);
    await scheduler.run('expenses.monthly', DEC_NOW);
    await scheduler.run('expenses.monthly', new Date('2026-12-02T09:00:00+09:00'));

    expect(notifier.notices).toHaveLength(1);
  });

  it('does nothing on another day of the month', async () => {
    const { scheduler, notifier } = await setup({ now: DEC_NOW, config: CONFIG, entries: NOV_ENTRIES });
    await scheduler.run('expenses.monthly', new Date('2026-12-02T09:00:00+09:00'));
    expect(notifier.notices).toHaveLength(0);
  });

  it('stays quiet when there is nothing to claim or review, and remembers the month', async () => {
    const { scheduler, notifier, kv } = await setup({ now: DEC_NOW, config: CONFIG, entries: [] });

    await scheduler.run('expenses.monthly', DEC_NOW);

    expect(notifier.notices).toHaveLength(0);
    expect(await kv.get('monthly:last')).toBe('2026-11');
  });

  it('offers only the review button when there are unsure entries and no candidates', async () => {
    const onlyWork = [NOV_ENTRIES[2]!];
    const { scheduler, notifier } = await setup({ now: DEC_NOW, config: CONFIG, entries: onlyWork });

    await scheduler.run('expenses.monthly', DEC_NOW);

    expect(notifier.notices[0]?.text).toContain('확인 필요 1건');
    expect(notifier.notices[0]?.text).not.toContain('합계: 0원');
    expect(notifier.notices[0]?.choices).toEqual([{ id: 'exp.review:2026-11', label: '후보 확인' }]);
  });

  it('does nothing without a spend reader', async () => {
    const { scheduler, notifier } = await setup({ now: DEC_NOW, config: CONFIG, withSpend: false });
    await expect(scheduler.run('expenses.monthly', DEC_NOW)).resolves.toBeUndefined();
    expect(notifier.notices).toHaveLength(0);
  });
});

describe('expenses.choices handler', () => {
  it('lists unsure entries with claim and personal buttons', async () => {
    const context = await setup({ now: DEC_NOW, config: CONFIG, entries: NOV_ENTRIES });
    const handler = await findHandler(context);
    const replier = new FakeReplier();

    await expect(handler.handle(incoming('(choice: exp.review:2026-11)'), replier)).resolves.toBe('handled');

    const message = replier.replies[0]?.message;
    expect(message?.text).toContain('2026년 11월 후보 확인');
    expect(message?.text).toContain('청구 후보 2건');
    expect(message?.text).toContain('- 11/05  OpenAI  20,000원  업무용 AI');
    expect(message?.choices).toEqual([
      { id: 'exp.mark:ai1:claim', label: '청구' },
      { id: 'exp.mark:ai1:personal', label: '개인' },
    ]);
  });

  it('says there is nothing to review', async () => {
    const context = await setup({ now: DEC_NOW, config: CONFIG, entries: NOV_ENTRIES.slice(0, 2) });
    const handler = await findHandler(context);
    const replier = new FakeReplier();

    await handler.handle(incoming('(choice: exp.review:2026-11)'), replier);
    expect(replier.replies[0]?.message.text).toContain('확인할 항목이 없어요.');
    expect(replier.replies[0]?.message.choices).toBeUndefined();
  });

  it('shows at most five unsure entries and says how many remain', async () => {
    const merchants = ['OpenAI', 'Anthropic', 'GitHub', 'Vercel', 'Cloudflare', 'Supabase', 'Netlify'];
    const entries = merchants.map((merchant, index) =>
      entry({
        id: `ai${index}`,
        merchant,
        category: 'ai',
        amount: 10_000,
        at: `2026-11-0${index + 1}T10:00:00+09:00`,
      }),
    );
    const context = await setup({ now: DEC_NOW, config: CONFIG, entries });
    const handler = await findHandler(context);
    const replier = new FakeReplier();

    await handler.handle(incoming('(choice: exp.review:2026-11)'), replier);

    const message = replier.replies[0]?.message;
    const listed = (message?.text ?? '').split('\n').filter((line) => line.startsWith('- '));
    expect(listed).toHaveLength(5);
    expect(message?.text).toContain('그 밖에 2건 더 있어요.');
    expect(message?.choices).toHaveLength(10);
  });

  it('marks an entry as claim through the tool', async () => {
    const context = await setup({ now: DEC_NOW, config: CONFIG, entries: NOV_ENTRIES });
    const handler = await findHandler(context);
    const replier = new FakeReplier();

    await handler.handle(incoming('(choice: exp.mark:ai1:claim)'), replier);

    expect(replier.replies[0]?.message.text).toContain('청구로 표시했어요');
    const summary = await context.ctx.tools.execute('expenses.summary', { month: '2026-11' });
    expect(summary.status).toBe('done');
    const output = (summary as { status: 'done'; output: SummaryOutput }).output;
    expect(output.candidateCount).toBe(3);
    expect(output.unsureCount).toBe(0);
  });

  it('marks an entry as personal through the tool', async () => {
    const context = await setup({ now: DEC_NOW, config: CONFIG, entries: NOV_ENTRIES });
    const handler = await findHandler(context);
    const replier = new FakeReplier();

    await handler.handle(incoming('(choice: exp.mark:ai1:personal)'), replier);

    expect(replier.replies[0]?.message.text).toContain('개인으로 표시했어요');
    const summary = await context.ctx.tools.execute('expenses.summary', { month: '2026-11' });
    const output = (summary as { status: 'done'; output: SummaryOutput }).output;
    expect(output.candidateCount).toBe(2);
    expect(output.unsureCount).toBe(0);
  });

  it('creates a draft and offers the approved send button', async () => {
    const composer = new FakeComposer('draft-1');
    const context = await setup({
      now: DEC_NOW,
      config: CONFIG,
      entries: NOV_ENTRIES,
      capabilities: { [Contracts.mailCompose.id]: composer },
    });
    const handler = await findHandler(context);
    const replier = new FakeReplier();

    await handler.handle(incoming('(choice: exp.draft:2026-11)'), replier);

    const message = replier.replies[0]?.message;
    expect(message?.text).toContain('제목: 예시회사 2026년 11월 경비 청구');
    expect(message?.text).toContain('11/03  카페 예시  5,000원  평일 점심 식대');
    expect(message?.text).toContain('아직 보내지 않았어요');
    expect(message?.choices).toEqual([{ id: 'exp.send:draft-1', label: '보내기(승인 필요)' }]);
    expect(composer.drafts).toHaveLength(1);
  });

  it('explains that there is no recipient', async () => {
    const context = await setup({
      now: DEC_NOW,
      config: { ...CONFIG, claimTo: [] },
      entries: NOV_ENTRIES,
    });
    const handler = await findHandler(context);
    const replier = new FakeReplier();

    await handler.handle(incoming('(choice: exp.draft:2026-11)'), replier);
    expect(replier.replies[0]?.message.text).toContain('주소가 없어요');
  });

  it('sends the draft only through mail.send_draft with approval', async () => {
    const confirmer = new FakeConfirmer('approved');
    const drafter = new FakeDrafter();
    const draft: MailDraft = {
      draftId: 'draft-1',
      to: ['team@example.com'],
      cc: [],
      subject: '예시회사 2026년 11월 경비 청구',
      body: 'body',
    };
    drafter.add(draft);
    const context = await setup({
      now: DEC_NOW,
      config: CONFIG,
      entries: NOV_ENTRIES,
      confirmer,
      capabilities: { [Contracts.mailDraft.id]: drafter },
    });
    const sent: unknown[] = [];
    context.ctx.registerTool({
      name: 'mail.send_draft',
      description: 'fake send',
      input: z.object({
        draftId: z.string(),
        to: z.array(z.string()),
        cc: z.array(z.string()).optional(),
        subject: z.string(),
        body: z.string(),
      }),
      effects: ['send'],
      async run(input) {
        sent.push(input);
        return { messageId: 'm1' };
      },
    });
    const handler = await findHandler(context);
    const replier = new FakeReplier();

    await handler.handle(incoming('(choice: exp.send:draft-1)'), replier);

    expect(replier.replies[0]?.message.text).toBe('청구 메일을 보냈어요.');
    expect(sent).toEqual([
      { draftId: 'draft-1', to: ['team@example.com'], cc: [], subject: draft.subject, body: 'body' },
    ]);
    expect(confirmer.requests).toHaveLength(1);
    expect(confirmer.requests[0]?.toolName).toBe('mail.send_draft');
    expect(confirmer.requests[0]?.effects).toEqual(['send']);
  });

  it('does not send when the approval is denied', async () => {
    const confirmer = new FakeConfirmer('denied');
    const drafter = new FakeDrafter();
    drafter.add({
      draftId: 'draft-1',
      to: ['team@example.com'],
      cc: [],
      subject: 'claim',
      body: 'body',
    });
    const context = await setup({
      now: DEC_NOW,
      config: CONFIG,
      entries: NOV_ENTRIES,
      confirmer,
      capabilities: { [Contracts.mailDraft.id]: drafter },
    });
    const sent: unknown[] = [];
    context.ctx.registerTool({
      name: 'mail.send_draft',
      description: 'fake send',
      input: z.object({
        draftId: z.string(),
        to: z.array(z.string()),
        cc: z.array(z.string()).optional(),
        subject: z.string(),
        body: z.string(),
      }),
      effects: ['send'],
      async run(input) {
        sent.push(input);
        return { messageId: 'm1' };
      },
    });
    const handler = await findHandler(context);
    const replier = new FakeReplier();

    await handler.handle(incoming('(choice: exp.send:draft-1)'), replier);

    expect(replier.replies[0]?.message.text).toContain('보내지 않았어요');
    expect(sent).toHaveLength(0);
  });

  it('explains when mail sending is not connected', async () => {
    const context = await setup({ now: DEC_NOW, config: CONFIG, entries: NOV_ENTRIES });
    const handler = await findHandler(context);
    const replier = new FakeReplier();

    await handler.handle(incoming('(choice: exp.send:draft-1)'), replier);
    expect(replier.replies[0]?.message.text).toBe('메일 보내기가 연결되지 않았어요.');
  });

  it('passes on other people, other choices and plain text', async () => {
    const context = await setup({ now: DEC_NOW, config: CONFIG, entries: NOV_ENTRIES });
    const handler = await findHandler(context);
    const replier = new FakeReplier();

    await expect(handler.handle(incoming('(choice: exp.review:2026-11)', false), replier)).resolves.toBe('pass');
    await expect(handler.handle(incoming('(choice: day.draft:m1)'), replier)).resolves.toBe('pass');
    await expect(handler.handle(incoming('안녕하세요'), replier)).resolves.toBe('pass');
    expect(replier.replies).toHaveLength(0);
  });
});
