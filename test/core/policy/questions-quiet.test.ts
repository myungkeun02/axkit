import { describe, expect, it } from 'vitest';
import { quietGate } from '../../../src/core/notify/quiet-gate.js';
import { OwnerQuestions } from '../../../src/core/policy/questions.js';
import { SqliteTopicAnswers, TOPIC_MIGRATIONS } from '../../../src/core/policy/topics.js';
import type { ConfirmChoice, Confirmer } from '../../../src/core/policy/types.js';
import { openSqliteStore } from '../../../src/core/store/sqlite.js';
import { FakeClock } from '../helpers.js';

const CHOICES: ConfirmChoice[] = [
  { id: 'yes', label: '그렇게 해 줘', means: 'approved' },
  { id: 'no', label: '그냥 둘게', means: 'denied' },
];
const HOUR_MS = 3_600_000;

async function setup(start: string, ownerActiveAt?: () => Date | undefined) {
  const store = openSqliteStore(':memory:');
  await store.migrate(TOPIC_MIGRATIONS);
  const clock = new FakeClock(new Date(start));
  const topics = new SqliteTopicAnswers(store.sql, () => clock.now());
  const shownAt: string[] = [];
  const confirmer: Confirmer = {
    async confirm(request) {
      shownAt.push(clock.now().toISOString());
      request.report?.({ choice: 'yes' });
      return 'approved';
    },
  };
  const gate = quietGate({
    clock,
    timeZone: 'Asia/Seoul',
    quietHours: { from: '22:00', to: '07:00' },
    ...(ownerActiveAt !== undefined ? { ownerActiveAt } : {}),
  });
  const questions = new OwnerQuestions({ topics, confirmer: () => confirmer, now: () => clock.now(), gate });
  return { clock, questions, shownAt };
}

const request = { topic: 'assistant:open:o123456', summary: '이렇게 처리할까요?', choices: CHOICES, askedBy: 'test' };

describe('owner questions and quiet hours', () => {
  it('holds a proactive card until the quiet window ends', async () => {
    const { clock, questions, shownAt } = await setup('2026-11-23T03:00:00+09:00');
    let done = false;
    const answer = questions.ask(request).then((result) => {
      done = true;
      return result;
    });
    await clock.advance(3 * HOUR_MS);
    expect(shownAt).toEqual([]);
    expect(done).toBe(false);
    await clock.advance(1 * HOUR_MS);
    expect(await answer).toMatchObject({ status: 'answered', choice: 'yes' });
    expect(shownAt).toEqual([new Date('2026-11-23T07:00:00+09:00').toISOString()]);
  });

  it('asks at once when the question is part of a reply, or when the owner is awake and chatting', async () => {
    const reply = await setup('2026-11-23T03:00:00+09:00');
    await reply.questions.ask({ ...request, proactive: false });
    expect(reply.shownAt).toHaveLength(1);

    const awake = await setup('2026-11-23T03:00:00+09:00', () => new Date('2026-11-23T02:55:00+09:00'));
    await awake.questions.ask(request);
    expect(awake.shownAt).toHaveLength(1);
  });

  it('asks at once outside quiet hours', async () => {
    const { questions, shownAt } = await setup('2026-11-23T10:00:00+09:00');
    await questions.ask(request);
    expect(shownAt).toHaveLength(1);
  });
});
