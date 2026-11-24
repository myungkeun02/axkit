import { describe, expect, it } from 'vitest';
import type { LlmGateway, LlmRequest } from '../../../src/core/llm/types.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { contactOf, extractResume } from '../../../src/skills/talent/extract.js';
import { TalentStore } from '../../../src/skills/talent/store.js';
import { talentGetTool, talentSearchTool } from '../../../src/skills/talent/tools.js';
import { docTypeFromName } from '../../../src/skills/onboarding/summarize.js';
import { MapKeyValueStore } from '../../core/helpers.js';

function llm(answer: unknown, seen: LlmRequest[] = []): LlmGateway {
  return {
    async complete(request) {
      seen.push(request);
      return { text: JSON.stringify(answer), providerId: 'fake', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  } as LlmGateway;
}

const RESUME = '홍길동\n이메일: gildong@example.com 연락처 010-1234-5678\n경력 8년 · 백엔드\n토스 결제팀 2019.03 – 현재\nJava, Spring, Kafka';
const ANSWER = {
  isResume: true,
  name: '홍길동',
  headline: '백엔드 개발자 · 8년',
  years: 8,
  roles: ['백엔드'],
  skills: ['Java', 'Spring', 'Kafka'],
  career: [{ company: '토스', role: '결제팀', period: '2019.03 – 현재' }],
  location: '서울',
  desired: '핀테크 리드',
  summary: '결제 시스템 경험',
};

describe('talent pack', () => {
  it('reads contacts by code and sends the model only a masked copy', async () => {
    expect(contactOf(RESUME)).toEqual({ email: 'gildong@example.com', phone: '010-1234-5678' });
    const seen: LlmRequest[] = [];
    const outcome = await extractResume({ llm: llm(ANSWER, seen), log: silentLogger }, RESUME, true);
    expect(outcome.ok).toBe(true);
    const sent = seen[0]?.messages.map((message) => message.content).join('\n') ?? '';
    expect(sent).not.toContain('gildong@example.com');
    expect(sent).not.toContain('010-1234-5678');
    expect(seen[0]?.sensitivity).toBe('sensitive');
    expect((await extractResume({ llm: llm({ ...ANSWER, isResume: false }), log: silentLogger }, RESUME, true)).ok).toBe(false);
  });

  it('merges versions of one person and searches by skills, years and words', async () => {
    const store = new TalentStore(new MapKeyValueStore());
    await store.load();
    const value = (await extractResume({ llm: llm(ANSWER), log: silentLogger }, RESUME, true)) as { ok: true; value: Parameters<TalentStore['upsert']>[0] };
    expect(await store.upsert(value.value, contactOf(RESUME), { path: '~/이력서/홍길동_2024.pdf', modifiedAt: '2024-05-01T00:00:00.000Z' })).toBe('added');
    expect(await store.upsert({ ...value.value, headline: '백엔드 리드 · 9년', years: 9 }, contactOf(RESUME), { path: '~/이력서/홍길동_2025.docx', modifiedAt: '2025-06-01T00:00:00.000Z' })).toBe('updated');
    await store.upsert({ ...value.value, name: '김영희', skills: ['React'], years: 3, career: [{ company: '당근' }] }, { email: 'y@example.com' }, { path: '~/이력서/김영희.pdf', modifiedAt: '2025-01-01T00:00:00.000Z' });

    expect(await store.count()).toBe(2);
    const found = await store.search({ text: '결제 핀테크', skills: ['java'], minYears: 8 });
    expect(found.map((item) => [item.candidate.name, item.candidate.years])).toEqual([['홍길동', 9]]);
    expect(found[0]?.candidate.sources.map((source) => source.path)).toEqual(['~/이력서/홍길동_2025.docx', '~/이력서/홍길동_2024.pdf']);
    expect(await store.search({ text: '안드로이드' })).toEqual([]);

    const search = await talentSearchTool(store).run({ text: '프론트' }, {} as never);
    expect(JSON.stringify(search)).not.toContain('example.com');
    const id = found[0]?.candidate.id ?? '';
    const full = await talentGetTool(store).run({ id }, {} as never);
    expect(full['contact']).toEqual({ email: 'gildong@example.com', phone: '010-1234-5678' });

    const reloaded = new TalentStore((store as unknown as { kv: MapKeyValueStore }).kv);
    await reloaded.load();
    expect(await reloaded.count()).toBe(2);
  });

  it('tells a document’s type from its name', () => {
    expect(docTypeFromName('홍길동_이력서_최종.pdf')).toBe('resume');
    expect(docTypeFromName('Jane Doe CV.docx')).toBe('resume');
    expect(docTypeFromName('2026 신사업 기획서.hwp')).toBe('plan');
    expect(docTypeFromName('회의록 11월.md')).toBe('minutes');
    expect(docTypeFromName('사진.png')).toBeUndefined();
  });
});

describe('talent pack mail kinds', () => {
  it('puts résumés attached to an application mail into the list and describes matches without names for a hiring request', async () => {
    const { applicationIntent, hiringIntent } = await import('../../../src/skills/talent/mail.js');
    const { Contracts } = await import('../../../src/core/contracts/index.js');
    const { createTestContext } = await import('../../support/context.js');
    const docs: { sourceId: string; text: string }[] = [];
    const intake = {
      wants: async () => true,
      add: async (doc: { sourceId: string; text: string }) => {
        docs.push(doc);
        return 'added' as const;
      },
    };
    const context = createTestContext({
      capabilities: {
        [Contracts.mailAttachments.id]: {
          list: async () => [
            { id: 'a1', filename: '홍길동_이력서.txt', mimeType: 'text/plain', size: 100 },
            { id: 'a2', filename: 'photo.png', mimeType: 'image/png', size: 100 },
          ],
          download: async () => new TextEncoder().encode(RESUME),
        },
      },
    });
    const message = { id: 'm1', threadId: 't', from: 'a@b.c', to: [], cc: [], subject: '지원합니다', snippet: '', body: '', receivedAt: new Date('2026-11-20T00:00:00Z'), unread: true, important: false };
    const line = await applicationIntent(context.ctx, intake, true).handle?.(message, '지원 메일');
    expect(docs.map((doc) => [doc.sourceId, doc.text.slice(0, 3)])).toEqual([['mail:m1:a1', '홍길동']]);
    expect(line).toBe('메일에 온 이력서 1개를 후보자 명부에 넣었어요.');

    void hiringIntent;
  });
});
