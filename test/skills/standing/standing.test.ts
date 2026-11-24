import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { LlmGateway, LlmRequest } from '../../../src/core/llm/types.js';
import { rememberAttachments } from '../../../src/skills/mail/attachment-memory.js';
import { standingSkill } from '../../../src/skills/standing/plugin.js';
import { createTestContext } from '../../support/context.js';

function model(answer: (request: LlmRequest) => unknown, seen: LlmRequest[] = []): LlmGateway {
  return {
    async complete(request) {
      seen.push(request);
      return { text: JSON.stringify(answer(request)), providerId: 'fake', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  } as LlmGateway;
}

const NOW = new Date('2026-11-23T09:00:00+09:00');

async function setup(answer: (request: LlmRequest) => unknown, page: { text: string } = { text: '' }) {
  const notices: string[] = [];
  const seen: LlmRequest[] = [];
  const context = createTestContext({
    now: NOW,
    llm: model(answer, seen),
    capabilities: {
      [Contracts.notifier.id]: { notify: async (notice: { text: string }) => void notices.push(notice.text) },
      [Contracts.webPage.id]: { read: async (url: string) => ({ url, status: 200, text: page.text, fetchedAt: NOW }) },
    },
  });
  await standingSkill().setup(context.ctx);
  return { context, notices, seen, page };
}

describe('standing orders', () => {
  it('tells the owner when a mail meets an order, and only then', async () => {
    const { context, notices } = await setup((request) => ({ hits: request.messages.at(-1)?.content.includes('견적서 송부') === true ? [{ order: 'O1', item: 'I1', why: '견적 메일이에요' }] : [] }));
    const added = await context.ctx.tools.execute('standing.add', { text: '에이크미에서 견적 메일 오면 바로 알려줘', source: 'mail', condition: 'Acme가 보낸 견적 관련 메일' }, { grounding: [] });
    expect(added.status).toBe('done');
    await context.bus.emit('mail.triaged', { id: 'm1', from: 'Kim <kim@acme.co.kr>', subject: '견적서 송부', summary: '김 과장이 견적서를 보냈어요.', kind: 'document_request', importance: 'high' });
    await context.bus.emit('mail.triaged', { id: 'm2', from: 'News <n@x.com>', subject: '주간 소식', summary: '뉴스레터', kind: 'notice', importance: 'low' });
    expect(notices).toEqual(['말씀하신 "에이크미에서 견적 메일 오면 바로 알려줘"에 맞는 메일이 왔어요.\nKim: 견적서 송부\n김 과장이 견적서를 보냈어요.\n(견적 메일이에요)']);
    const list = await context.ctx.tools.execute('standing.list', {}, { grounding: [] });
    expect(list).toMatchObject({ status: 'done', output: { orders: [{ hits: 1, source: 'mail' }] } });
  });

  it('learns what a page already shows, then reports only new matching lines', async () => {
    const { context, notices, seen, page } = await setup(() => ({ hits: [{ order: 'O1', item: 'I1', why: 'iOS 채용이에요' }] }), { text: '백엔드 개발자 채용 공고 (상시)\n디자이너 채용 공고 마감' });
    const added = await context.ctx.tools.execute('standing.add', { text: '토스 iOS 채용 나오면 알려줘', source: 'web', condition: 'iOS 개발자 채용 공고', url: 'https://toss.example/careers' }, { grounding: [] });
    expect(added.status).toBe('done');
    // the first look only learns the page
    expect(seen).toHaveLength(0);
    page.text = '백엔드 개발자 채용 공고 (상시)\n디자이너 채용 공고 마감\niOS 개발자 채용 공고 (신규)';
    await context.scheduler.jobs.get('standing.check')?.run(NOW);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.messages.at(-1)?.content).toContain('I1. iOS 개발자 채용 공고 (신규)');
    expect(seen[0]?.messages.at(-1)?.content).not.toContain('백엔드');
    expect(notices[0]).toContain('• iOS 개발자 채용 공고 (신규) — iOS 채용이에요');
    await context.scheduler.jobs.get('standing.check')?.run(NOW);
    expect(seen).toHaveLength(1);
  });

  it('builds a news search for a news order and ends orders on their date', async () => {
    const { context } = await setup(() => ({ hits: [] }));
    const added = await context.ctx.tools.execute('standing.add', { text: '반도체 수출 규제 뉴스', source: 'news', condition: '한국 반도체 수출 규제 관련 새 기사', query: '반도체 수출 규제', days: 1 }, { grounding: [] });
    expect(JSON.stringify(added)).toContain('"query":"반도체 수출 규제"');
    await context.clock.advance(2 * 86_400_000);
    await context.scheduler.jobs.get('standing.check')?.run(context.clock.now());
    expect(await context.ctx.tools.execute('standing.list', {}, { grounding: [] })).toMatchObject({ output: { orders: [] } });
    const bad = await context.ctx.tools.execute('standing.add', { text: 'x', source: 'web', condition: 'yy' }, { grounding: [] });
    expect(bad.status).not.toBe('done');
  });
});

describe('remembering attachments', () => {
  it('keeps one line per readable file and skips what cannot be read', async () => {
    const remembered: string[] = [];
    const context = createTestContext({
      now: NOW,
      llm: model(() => ({ summary: '11월 납품 견적, 총 1,240만원, 납기 12월 5일' })),
      capabilities: {
        [Contracts.mailAttachments.id]: {
          list: async () => [
            { id: 'a1', filename: '견적서.txt', mimeType: 'text/plain', size: 200 },
            { id: 'a2', filename: 'photo.png', mimeType: 'image/png', size: 200 },
          ],
          download: async () => new TextEncoder().encode('견적서\n품목: 서버 랙 4대\n합계: 12,400,000원\n납기: 2026-12-05\n담당: 김 과장'),
        },
        [Contracts.memoryWrite.id]: { remember: async (input: { text: string }) => (remembered.push(input.text), { id: 'f' }) },
      },
    });
    const message = { id: 'm1', threadId: 't', from: 'Kim <kim@acme.co.kr>', to: [], cc: [], subject: '견적', snippet: '', body: '', receivedAt: NOW, unread: true, important: false };
    expect(await rememberAttachments(context.ctx, message)).toBe(1);
    expect(remembered).toEqual([`Kim님이 ${NOW.toISOString().slice(0, 10)}에 보낸 첨부 "견적서.txt": 11월 납품 견적, 총 1,240만원, 납기 12월 5일`]);
  });
});
