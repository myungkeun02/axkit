import { describe, expect, it } from 'vitest';
import { openSqliteStore } from '../../../src/core/store/sqlite.js';
import { OwnerQuestions } from '../../../src/core/policy/questions.js';
import { SqliteTopicAnswers, TOPIC_MIGRATIONS, decideTopic } from '../../../src/core/policy/topics.js';
import type { ConfirmChoice, ConfirmRequest, Confirmer } from '../../../src/core/policy/types.js';

const CHOICES: ConfirmChoice[] = [
  { id: 'bot', label: '개발 봇에게 맡기기', tone: 'primary', means: 'approved' },
  { id: 'later', label: '나중에', means: 'later' },
  { id: 'no', label: '안 함', tone: 'danger', means: 'denied' },
];

async function setup(answer: (request: ConfirmRequest) => { choice?: string; text?: string } | 'expired') {
  const store = openSqliteStore(':memory:');
  await store.migrate(TOPIC_MIGRATIONS);
  let now = new Date('2026-11-19T00:00:00Z');
  const topics = new SqliteTopicAnswers(store.sql, () => now);
  const asked: string[] = [];
  const confirmer: Confirmer = {
    async confirm(request) {
      asked.push(request.topic ?? '');
      const value = answer(request);
      if (value === 'expired') return 'expired';
      request.report?.(value);
      return value.choice === 'bot' ? 'approved' : 'denied';
    },
  };
  const questions = new OwnerQuestions({ topics, confirmer: () => confirmer, now: () => now });
  const ask = (facts?: string) =>
    questions.ask({ topic: 'dev:suggest:export', summary: '이걸로 개발해 볼까요?', choices: CHOICES, askedBy: 'test', ...(facts !== undefined ? { facts } : {}) });
  return {
    ask,
    asked,
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('same question never twice (R15)', () => {
  it('a yes is reused without asking again', async () => {
    const { ask, asked } = await setup(() => ({ choice: 'bot' }));
    expect(await ask()).toMatchObject({ status: 'answered', choice: 'bot', reused: false });
    expect(await ask()).toMatchObject({ status: 'answered', choice: 'bot', reused: true });
    expect(asked).toHaveLength(1);
  });

  it('a no or a typed reply holds until the facts change', async () => {
    const { ask, asked } = await setup(() => ({ choice: 'no' }));
    expect(await ask('doc-1')).toMatchObject({ status: 'answered', means: 'denied' });
    expect(await ask('doc-1')).toEqual({ status: 'skipped', reason: 'declined' });
    expect(await ask()).toEqual({ status: 'skipped', reason: 'declined' });
    expect(await ask('doc-2')).toMatchObject({ status: 'answered' });
    expect(asked).toHaveLength(2);
    const typed = await setup(() => ({ text: '결제 말고 정산부터' }));
    expect(await typed.ask()).toMatchObject({ status: 'answered', choice: 'text', text: '결제 말고 정산부터' });
    expect(await typed.ask()).toEqual({ status: 'skipped', reason: 'declined' });
  });

  it('later comes back once when due, then never on its own', async () => {
    const { ask, asked, advance } = await setup(() => ({ choice: 'later' }));
    expect(await ask()).toMatchObject({ means: 'later' });
    expect(await ask()).toEqual({ status: 'skipped', reason: 'later' });
    advance(21 * 3_600_000);
    expect(await ask()).toMatchObject({ status: 'answered', means: 'later' });
    advance(48 * 3_600_000);
    expect(await ask()).toEqual({ status: 'skipped', reason: 'reopened_once' });
    expect(asked).toHaveLength(2);
    expect(decideTopic(undefined, undefined, new Date())).toEqual({ kind: 'ask', reopening: false });
  });

  it('an unanswered card is not remembered', async () => {
    const { ask, asked } = await setup(() => 'expired');
    expect(await ask()).toEqual({ status: 'expired' });
    expect(await ask()).toEqual({ status: 'expired' });
    expect(asked).toHaveLength(2);
  });
});
