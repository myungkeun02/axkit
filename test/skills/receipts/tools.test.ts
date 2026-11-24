import { describe, expect, it } from 'vitest';
import { receiptsSkill } from '../../../src/skills/receipts/plugin.js';
import { addEntry } from '../../../src/skills/receipts/store.js';
import type { DocEntry } from '../../../src/skills/receipts/types.js';
import { createTestContext } from '../../support/context.js';
import { docEntry, NOW } from './helpers.js';

async function setup() {
  const context = createTestContext({ now: NOW });
  await receiptsSkill().setup(context.ctx);
  const docs: DocEntry[] = [
    docEntry({
      id: 'doc-1',
      mailId: 'mail-1',
      kind: 'receipt',
      subject: '카페 결제',
      from: '카페 예시 <billing@example.com>',
      merchant: '카페 예시',
      merchantKey: '카페예시',
      at: '2026-11-05T12:00:00+09:00',
    }),
    docEntry({
      id: 'doc-2',
      mailId: 'mail-2',
      kind: 'receipt',
      subject: '서점 결제',
      from: '서점 <shop@example.com>',
      merchant: '서점',
      merchantKey: '서점',
      at: '2026-11-15T12:00:00+09:00',
    }),
    docEntry({
      id: 'doc-3',
      mailId: 'mail-3',
      kind: 'invoice',
      subject: '호스팅 인보이스',
      from: 'Example Hosting <billing@hosting.example.com>',
      merchant: 'Example Hosting',
      merchantKey: 'examplehosting',
      at: '2026-11-10T12:00:00+09:00',
    }),
    docEntry({
      id: 'doc-4',
      mailId: 'mail-4',
      kind: 'statement',
      subject: '10월 명세서',
      from: 'Example Card <notice@example.com>',
      merchant: 'Example Card',
      merchantKey: 'examplecard',
      at: '2026-10-20T12:00:00+09:00',
    }),
  ];
  for (const entry of docs) {
    await addEntry(context.ctx.kv, entry.at.slice(0, 7), entry);
  }
  return context;
}

async function run(ctx: ReturnType<typeof createTestContext>['ctx'], name: string, input: unknown) {
  const outcome = await ctx.tools.execute(name, input);
  if (outcome.status !== 'done') throw new Error(`unexpected status: ${outcome.status}`);
  return outcome.output as DocEntry[];
}

describe('docs.list', () => {
  it('defaults to the current month and returns newest first', async () => {
    const { ctx } = await setup();
    const results = await run(ctx, 'docs.list', {});

    expect(results.map((entry) => entry.id)).toEqual(['doc-2', 'doc-3', 'doc-1']);
    expect(results[0]?.files[0]).toContain('/mail.txt');
    expect(results[0]).not.toHaveProperty('body');
  });

  it('filters by kind and by month', async () => {
    const { ctx } = await setup();

    expect((await run(ctx, 'docs.list', { kind: 'invoice' })).map((entry) => entry.id)).toEqual(['doc-3']);
    expect((await run(ctx, 'docs.list', { month: '2026-10' })).map((entry) => entry.id)).toEqual(['doc-4']);
  });

  it('rejects a malformed month', async () => {
    const { ctx } = await setup();
    const outcome = await ctx.tools.execute('docs.list', { month: '2026-13' });
    expect(outcome.status).toBe('invalid_input');
  });
});

describe('docs.search', () => {
  it('matches words against subject, sender, merchant and kind', async () => {
    const { ctx } = await setup();

    expect((await run(ctx, 'docs.search', { text: '카페' })).map((entry) => entry.id)).toEqual(['doc-1']);
    expect((await run(ctx, 'docs.search', { text: 'example hosting' })).map((entry) => entry.id)).toEqual(['doc-3']);
    expect((await run(ctx, 'docs.search', { text: '영수증' })).map((entry) => entry.id)).toEqual(['doc-2', 'doc-1']);
  });

  it('honours month and limit', async () => {
    const { ctx } = await setup();

    expect((await run(ctx, 'docs.search', { text: '명세서', month: '2026-10' })).map((entry) => entry.id)).toEqual([
      'doc-4',
    ]);
    expect((await run(ctx, 'docs.search', { text: '결제', limit: 1 })).map((entry) => entry.id)).toEqual(['doc-2']);
  });

  it('returns metadata and relative paths only', async () => {
    const { ctx } = await setup();
    const [entry] = await run(ctx, 'docs.search', { text: '카페' });

    expect(entry).toEqual({
      id: 'doc-1',
      mailId: 'mail-1',
      kind: 'receipt',
      subject: '카페 결제',
      from: '카페 예시 <billing@example.com>',
      at: '2026-11-05T12:00:00+09:00',
      amount: 50_000,
      currency: 'KRW',
      merchant: '카페 예시',
      merchantKey: '카페예시',
      files: ['2026-11/2026-11-03-receipt-영수증 안내-mail-1/mail.txt'],
    });
  });
});
