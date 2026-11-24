import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { MailMessage, MailQuery, MailSummary } from '../../../src/core/contracts/index.js';
import type { LlmGateway, LlmRequest } from '../../../src/core/llm/types.js';
import { checkOutcomes, draftStats, evalCases, recordDraft, similarity } from '../../../src/skills/mail/draft-outcomes.js';
import { writeDraft } from '../../../src/skills/mail/draft-writer.js';
import { runDraftEval } from '../../../src/skills/mail/quality.js';
import { learnStyle, ownText, readStyle } from '../../../src/skills/mail/style.js';
import { createTestContext } from '../../support/context.js';

const START = new Date('2026-11-20T09:00:00+09:00');

function msg(id: string, threadId: string, body: string, at: Date, subject = '견적'): MailMessage {
  return { id, threadId, from: 'Kim <kim@acme.co.kr>', to: [], cc: [], subject, snippet: '', body, receivedAt: at, unread: false, important: false };
}

class FakeMail {
  inbox: MailMessage[] = [];
  sent: MailMessage[] = [];
  async search(query: MailQuery): Promise<MailSummary[]> {
    return query.text?.includes('in:sent') === true ? this.sent : this.inbox;
  }
  async read(id: string): Promise<MailMessage> {
    const found = [...this.inbox, ...this.sent].find((item) => item.id === id);
    if (found === undefined) throw new Error('missing');
    return found;
  }
}

function llm(answer: (request: LlmRequest) => string, seen: LlmRequest[] = []): LlmGateway {
  return {
    async complete(request) {
      seen.push(request);
      return { text: answer(request), providerId: 'fake', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  } as LlmGateway;
}

describe('learning from the owner’s mail', () => {
  it('keeps only the owner’s own words and scores closeness by words', () => {
    expect(ownText('네 알겠습니다.\n감사합니다.\n\nOn Mon, Kim wrote:\n> 견적 주세요')).toBe('네 알겠습니다.\n감사합니다.');
    expect(ownText('확인했어요\n> 인용\n-----Original Message-----\n이전 내용')).toBe('확인했어요');
    expect(similarity('안녕하세요 견적 보내드립니다', '안녕하세요, 견적 보내드립니다!')).toBe(1);
    expect(similarity('a b c d', 'x y z w')).toBe(0);
  });

  it('tracks each draft: sent as is, sent after edits (a test case and a lesson), or not sent', async () => {
    const mail = new FakeMail();
    const seen: LlmRequest[] = [];
    const context = createTestContext({ now: START, llm: llm(() => '- 인사: "안녕하세요 대표님"\n- 끝: "감사합니다. 김OO 드림"\n- 짧게 3문장', seen), capabilities: { [Contracts.mailRead.id]: mail } });
    mail.inbox.push(msg('in1', 't1', '견적 부탁드려요', START), msg('in2', 't2', '자료 부탁드려요', START), msg('in3', 't3', '회의 가능하세요?', START));
    await recordDraft(context.ctx, { draftId: 'd1', messageId: 'in1', threadId: 't1', kind: 'question', body: '안녕하세요. 견적은 내일까지 보내드리겠습니다. 감사합니다.' });
    await recordDraft(context.ctx, { draftId: 'd2', messageId: 'in2', threadId: 't2', kind: 'document_request', body: '안녕하세요. 자료 첨부드립니다. 감사합니다.' });
    await recordDraft(context.ctx, { draftId: 'd3', messageId: 'in3', threadId: 't3', kind: 'scheduling', body: '화요일 2시 어떠세요?' });
    const later = new Date(START.getTime() + 3_600_000);
    mail.sent.push(
      msg('s1', 't1', '안녕하세요. 견적은 내일까지 보내드리겠습니다. 감사합니다.\n\nOn Mon, Kim wrote:\n> 견적', later),
      msg('s2', 't2', '대표님 안녕하세요! 요청하신 회사소개서 보내드려요. 확인 부탁드립니다. 김OO 드림', later),
    );

    await context.clock.advance(2 * 3_600_000);
    const first = await checkOutcomes(context.ctx);
    expect(first.checked).toBe(2);
    expect(first.edits.map((edit) => edit.sent)).toEqual(['대표님 안녕하세요! 요청하신 회사소개서 보내드려요. 확인 부탁드립니다. 김OO 드림']);
    await context.clock.advance(8 * 24 * 3_600_000);
    await checkOutcomes(context.ctx);
    const stats = await draftStats(context.ctx);
    expect([stats.drafted, stats.asIs, stats.edited, stats.unsent, stats.pending]).toEqual([3, 1, 1, 1, 0]);
    expect(stats.byKind['document_request']).toEqual({ drafted: 1, asIs: 0 });
    expect((await evalCases(context.ctx)).map((item) => item.kind)).toEqual(['question', 'document_request']);

    const style = await learnStyle(context.ctx, first.edits);
    expect(style?.guide).toContain('안녕하세요 대표님');
    const asked = seen[0]?.messages.at(-1)?.content ?? '';
    expect(asked).toContain('what the owner actually sent');
    expect(asked).not.toContain('kim@acme.co.kr');
    expect((await readStyle(context.ctx))?.edits).toBe(1);
  });

  it('drafts in the learned style and replays the test set against it', async () => {
    const mail = new FakeMail();
    const seen: LlmRequest[] = [];
    const context = createTestContext({
      now: START,
      llm: llm((request) => (request.purpose === 'mail.draft' ? JSON.stringify({ body: '대표님 안녕하세요! 요청하신 회사소개서 보내드려요. 확인 부탁드립니다. 김OO 드림', attach: [], note: '' }) : '- 짧게'), seen),
      capabilities: { [Contracts.mailRead.id]: mail },
    });
    await context.ctx.kv.set('style', { guide: '인사는 "대표님 안녕하세요!"', learnedAt: START.toISOString(), samples: 5, edits: 1 });
    const plan = await writeDraft(context.ctx, { message: msg('x', 't', '자료 주세요', START), triage: { importance: 'normal', kind: 'document_request', summary: '', actions: [] }, baseline: '네', docs: [] });
    expect(plan.body).toContain('대표님 안녕하세요!');
    expect(seen[0]?.messages.at(-1)?.content).toContain('인사는 "대표님 안녕하세요!"');

    await context.ctx.kv.set('eval-cases', [{ kind: 'document_request', mail: 'From: Kim\nSubject: 자료\n\n자료 주세요', ours: '안녕하세요. 자료 첨부드립니다. 감사합니다.', sent: '대표님 안녕하세요! 요청하신 회사소개서 보내드려요. 확인 부탁드립니다. 김OO 드림', at: START.toISOString() }]);
    const run = await runDraftEval(context.ctx);
    expect(run?.cases).toBe(1);
    expect(run?.now).toBe(1);
    expect(run?.before ?? 1).toBeLessThan(0.5);
  });
});
