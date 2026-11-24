import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { KvDocStore } from '../../../src/core/docs/kv-doc-store.js';
import { decisionHandler } from '../../../src/skills/company/decisions.js';
import { workTexts } from '../../../src/skills/company/locale-work.js';
import { KvTaskRepository } from '../../../src/skills/company/store.js';
import { ensureTeamDocs } from '../../../src/skills/company/team-docs.js';
import { createTestContext } from '../../support/context.js';
import { makeReplier, MARKETING, message, NOW } from './helpers.js';

async function setup() {
  const context = createTestContext({ now: NOW });
  const docs = new KvDocStore(context.kv, () => context.clock.now());
  context.provided.set(Contracts.docs.id, docs);
  await ensureTeamDocs(docs, [MARKETING], workTexts('ko'));
  const repo = new KvTaskRepository(context.kv, () => context.clock.now());
  const handler = decisionHandler({ ctx: context.ctx, repo, texts: workTexts('ko') });
  return { context, docs, repo, handler };
}

describe('company.decision', () => {
  it('passes messages from other people and unrelated text', async () => {
    const { handler } = await setup();
    const { replier } = makeReplier();

    expect(await handler.handle(message('(choice: company.approve:abcd1234)', false), replier)).toBe('pass');
    expect(await handler.handle(message('그냥 잡담'), replier)).toBe('pass');
  });

  it('answers when the task is not waiting for the owner', async () => {
    const { handler } = await setup();
    const { replier, replies } = makeReplier();

    expect(await handler.handle(message('(choice: company.approve:abcd1234)'), replier)).toBe('handled');
    expect(replies[0]?.text).toBe('그 결정을 찾지 못했어요. 이미 처리됐을 수 있어요.');
  });

  it('closes the task as declined and logs the owner decision', async () => {
    const { docs, repo, handler } = await setup();
    const task = await repo.create({ team: 'marketing', title: '결제 요청', request: '결제', source: 'owner', status: 'queued' });
    await repo.update(task.id, (current) => ({
      ...current,
      status: 'awaiting_owner',
      ownerEffects: ['pay'],
      result: '결제 초안',
    }));
    const { replier, replies } = makeReplier();

    expect(await handler.handle(message(`(choice: company.decline:${task.id})`), replier)).toBe('handled');

    const closed = await repo.get(task.id);
    expect(closed?.status).toBe('closed');
    expect(closed?.closedReason).toBe('declined');
    expect(replies[0]?.text).toBe('결제 요청: 닫을게요.');
    const decisions = await docs.get('company:decisions:marketing');
    expect(decisions?.entries.at(-1)).toMatchObject({
      text: '대표 거절: 결제 요청',
      author: { kind: 'user', id: 'owner' },
      sources: [`task:${task.id}`],
    });
  });

  it('does not answer a choice for work that already finished', async () => {
    const { repo, handler } = await setup();
    const task = await repo.create({ team: 'marketing', title: '끝난 일', request: '일', source: 'owner', status: 'queued' });
    await repo.update(task.id, (current) => ({ ...current, status: 'done' }));
    const { replier, replies } = makeReplier();

    expect(await handler.handle(message(`(choice: company.approve:${task.id})`), replier)).toBe('handled');
    expect(replies[0]?.text).toContain('찾지 못했어요');
  });
});
