import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { mailView, rememberTriaged } from '../../../src/skills/mail/mail-view.js';
import { createTestContext } from '../../support/context.js';

describe('mail screen', () => {
  it('lists what the triage read, important first, with who wants what', async () => {
    const { ctx } = createTestContext({
      now: new Date('2026-11-25T03:00:00Z'),
      capabilities: { [Contracts.mailRead.id]: {}, [Contracts.mailAwaiting.id]: { awaitingReply: async () => [] } },
    });
    rememberTriaged(ctx);
    await ctx.bus.emit('mail.triaged', { id: 'm1', from: 'Mina Kim <mina@example.com>', subject: '견적 회의', summary: '견적서 확인과 25일 회의를 물었어요', kind: 'scheduling', importance: 'high' });
    await ctx.bus.emit('mail.triaged', { id: 'm2', from: 'Shop <noreply@shop.example>', subject: '할인', summary: '할인 안내', kind: 'notice', importance: 'low' });
    const { blocks } = (await mailView(ctx).read(new URLSearchParams())) as { blocks: { kind: string; title?: string; text?: string; rows?: { title: string; detail: string; message: string }[] }[] };
    const first = blocks.find((b) => b.title?.startsWith('먼저 보실 메일'));
    expect(first?.rows?.[0]).toMatchObject({ title: 'Mina Kim — 견적 회의', detail: '일정 잡기 · 견적서 확인과 25일 회의를 물었어요' });
    expect(first?.rows?.[0]?.message).toContain('어떻게 할지');
    expect(blocks.some((b) => b.text === '광고·알림 메일 1통은 따로 보여 드리지 않았어요.')).toBe(true);
  });
});
