import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { LlmGateway, LlmRequest } from '../../../src/core/llm/types.js';
import { hiringIntent } from '../../../src/skills/talent/mail.js';
import { matchRequest } from '../../../src/skills/talent/match.js';
import { TalentBook } from '../../../src/skills/talent/requests.js';
import { TalentStore } from '../../../src/skills/talent/store.js';
import { draftIntroTool } from '../../../src/skills/talent/draft-intro.js';
import { createTestContext } from '../../support/context.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';

const NOW = new Date('2026-11-23T00:00:00.000Z');

function scripted(answer: (request: LlmRequest) => unknown, seen: LlmRequest[] = []): LlmGateway {
  return {
    async complete(request) {
      seen.push(request);
      return { text: JSON.stringify(answer(request)), providerId: 'fake', model: 'm', usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    },
  } as LlmGateway;
}

async function people(): Promise<{ store: TalentStore; book: TalentBook; ids: Record<string, string> }> {
  const kv = new MapKeyValueStore();
  const store = new TalentStore(kv);
  await store.load();
  const book = new TalentBook(kv);
  await book.load();
  const add = async (name: string, skills: string[], years: number, company: string): Promise<string> => {
    await store.upsert({ name, headline: `백엔드 개발자 · ${years}년`, years, roles: ['백엔드'], skills, career: [{ company }], summary: `${company} 결제` }, { email: `${name}@x.io` }, { path: `~/r/${name}.pdf`, modifiedAt: '2025-01-01T00:00:00.000Z' });
    return (await store.search({ text: name }))[0]?.candidate.id ?? '';
  };
  return { store, book, ids: { kim: await add('김자바', ['Java', 'Spring'], 9, '토스'), lee: await add('이코틀린', ['Kotlin', 'Spring'], 6, '당근'), park: await add('박노드', ['Node'], 4, '쿠팡') } };
}

describe('hiring requests and introductions', () => {
  it('keeps one request per company and role, and one record per person, company and request', async () => {
    const { book, ids } = await people();
    const first = await book.upsertRequest({ company: 'Acme', title: '백엔드 리드', skills: ['Java'], source: 'chat' }, NOW);
    const again = await book.upsertRequest({ company: 'acme', title: '백엔드  리드', skills: ['Kafka'], source: 'chat' }, NOW);
    expect(again.created).toBe(false);
    expect(again.request.skills).toEqual(['Java', 'Kafka']);
    await book.logIntro({ candidateId: ids['kim'] ?? '', candidateName: '김자바', company: 'Acme', requestId: first.request.id, status: 'drafted' }, NOW);
    await book.logIntro({ candidateId: ids['kim'] ?? '', candidateName: '김자바', company: 'Acme', requestId: first.request.id, status: 'sent' }, NOW);
    expect(book.listIntros({ company: 'ACME' }).map((intro) => intro.status)).toEqual(['sent']);
    expect(book.introducedTo(ids['kim'] ?? '', 'Acme')).toBeDefined();
    await book.setIntroStatus(book.listIntros()[0]?.id ?? '', 'rejected', '연봉 차이', NOW);
    expect(book.introducedTo(ids['kim'] ?? '', 'Acme')).toBeUndefined();
  });

  it('ranks anonymous cards with reasons and leaves out people already introduced to that company', async () => {
    const { store, book, ids } = await people();
    const { request } = await book.upsertRequest({ company: 'Acme', title: '백엔드 개발자', skills: ['Spring'], minYears: 5, source: 'chat' }, NOW);
    await book.logIntro({ candidateId: ids['lee'] ?? '', candidateName: '이코틀린', company: 'Acme', status: 'sent' }, NOW);
    const seen: LlmRequest[] = [];
    const llm = scripted(() => ({ ranked: [{ id: 'C1', fit: 88, why: 'Spring 9년, 결제 경험' }, { id: 'C9', fit: 99, why: '없는 카드' }] }), seen);
    const result = await matchRequest({ llm, log: silentLogger, korean: true }, store, book, request);
    expect(result.by).toBe('model');
    expect(result.matches.map((match) => [match.candidate.name, match.fit, match.why])).toEqual([['김자바', 88, 'Spring 9년, 결제 경험']]);
    expect(result.skipped.map((item) => item.candidate.name)).toEqual(['이코틀린']);
    const sent = seen[0]?.messages.at(-1)?.content ?? '';
    expect(sent).not.toContain('김자바');
    expect(sent).not.toContain('@x.io');
    expect(sent).not.toContain('~/r/');
  });

  it('saves the positions a hiring mail asks for and gives the draft unnamed matches', async () => {
    const { store, book } = await people();
    const context = createTestContext({
      now: NOW,
      llm: scripted((request) =>
        request.purpose === 'talent.request'
          ? { positions: [{ company: '', title: '백엔드 개발자', skills: ['Spring'], minYears: 5, contact: '인사팀' }] }
          : { ranked: [{ id: 'C1', fit: 80, why: '맞아요' }] },
      ),
    });
    const intent = hiringIntent(context.ctx, store, book, true);
    const mail = { id: 'm1', threadId: 't', from: 'HR <hr@acme.co.kr>', to: [], cc: [], subject: '백엔드 개발자 추천 부탁드립니다', snippet: '', body: '5년 이상 Spring 개발자를 찾습니다.', receivedAt: NOW, unread: true, important: false };
    expect(await intent.handle?.(mail, '')).toBe('채용 요청 1건을 등록했어요: acme · 백엔드 개발자');
    expect(book.listRequests()[0]).toMatchObject({ company: 'acme', minYears: 5, mailId: 'm1', contact: '인사팀' });
    const facts = (await intent.context?.(mail, '')) ?? '';
    expect(facts).toContain('acme — 백엔드 개발자: 1 people');
    expect(facts).toContain('(fit 80): 맞아요');
    expect(facts).not.toContain('김자바');
  });

  it('drafts an introduction in the request’s thread without contacts and logs it as drafted', async () => {
    const seen: LlmRequest[] = [];
    const context = createTestContext({ now: NOW, llm: scripted(() => ({ subject: '후보 소개', body: '안녕하세요. 김자바 님을 소개드립니다.' }), seen) });
    const drafts: { messageId: string; body: string; attachments?: string[] | undefined }[] = [];
    context.ctx.registerTool({
      name: 'mail.draft_reply',
      description: 'fake',
      input: z.object({ messageId: z.string(), body: z.string(), attachments: z.array(z.string()).optional() }),
      effects: ['write'],
      async run(input) {
        drafts.push(input);
        return { draftId: 'd1', to: ['hr@acme.co.kr'], cc: [], subject: 'Re: x', body: input.body };
      },
    });
    const { store, book, ids } = await people();
    const { request } = await book.upsertRequest({ company: 'Acme', title: '백엔드', skills: [], source: 'mail: x', mailId: 'm9' }, NOW);
    const chat = await book.upsertRequest({ company: 'Beta', title: '프론트', skills: [], source: 'chat' }, NOW);
    const tool = draftIntroTool(context.ctx, store, book, true);
    const run = { log: silentLogger, signal: new AbortController().signal, call: { grounding: [] } };

    expect(await tool.run({ requestId: chat.request.id, candidateIds: [ids['kim'] ?? ''], attachResumes: false }, run)).toMatchObject({ found: false });
    const result = await tool.run({ requestId: request.id, candidateIds: [ids['kim'] ?? ''], attachResumes: true }, run);

    expect(result).toMatchObject({ drafted: true, attachments: ['~/r/김자바.pdf'] });
    expect(drafts).toEqual([{ messageId: 'm9', body: '안녕하세요. 김자바 님을 소개드립니다.', attachments: ['~/r/김자바.pdf'] }]);
    expect(seen[0]?.messages.at(-1)?.content).not.toContain('@x.io');
    expect(book.listIntros({ requestId: request.id }).map((intro) => [intro.candidateName, intro.status])).toEqual([['김자바', 'drafted']]);
  });
});
