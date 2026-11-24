import { describe, expect, it } from 'vitest';
import type { CardFeedback, TuningChange } from '../../../src/core/contracts/index.js';
import { monthRange } from '../../../src/core/time/local-day.js';
import { LabelStore } from '../../../src/skills/spending/classify/labels.js';
import { merchantKey } from '../../../src/skills/spending/normalize.js';
import type { SpendEntryView } from '../../../src/skills/spending/tools.js';
import type { TestContext } from '../../support/context.js';
import { NOW, setupSpending, spendReader, TIME_ZONE } from './helpers.js';

async function add(context: TestContext, merchant: string, amount: number, date: string): Promise<SpendEntryView> {
  const outcome = await context.ctx.tools.execute('spending.add', { merchant, amount, date });
  if (outcome.status !== 'done') throw new Error(JSON.stringify(outcome));
  return outcome.output as SpendEntryView;
}

async function setCategory(context: TestContext, input: Record<string, unknown>): Promise<void> {
  const outcome = await context.ctx.tools.execute('spending.set_category', input);
  if (outcome.status !== 'done') throw new Error(JSON.stringify(outcome));
}

async function applyRule(context: TestContext, subject: string, value: string | undefined, action: 'set' | 'unmute' = 'set'): Promise<void> {
  const change: TuningChange = {
    id: 'rule-1',
    domain: 'spend.category',
    subject,
    action,
    ...(value !== undefined ? { value } : {}),
  };
  await context.bus.emit('tuning.apply', change);
}

async function sourceOf(context: TestContext, merchant: string) {
  const [entry] = (await spendReader(context).entries(monthRange('2026-11', TIME_ZONE))).filter(
    (item) => item.merchant === merchant,
  );
  return entry;
}

describe('spending feedback on owner corrections', () => {
  it('emits one correction per set_category call when the category changes', async () => {
    const context = await setupSpending();
    const events: CardFeedback[] = [];
    context.bus.on('feedback.card', (feedback) => {
      events.push(feedback);
    });
    await add(context, '스타벅스', 12_300, '2026-11-02');
    await add(context, '스타벅스', 5_000, '2026-11-04');

    await setCategory(context, { merchant: '스타벅스', category: 'food' });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      domain: 'spend.category',
      subject: merchantKey('스타벅스'),
      verdict: 'corrected',
      correction: 'food',
      label: '스타벅스',
    });
    expect(events[0]?.at).toEqual(NOW);
  });

  it('does not emit when the category did not change', async () => {
    const context = await setupSpending();
    const events: CardFeedback[] = [];
    context.bus.on('feedback.card', (feedback) => {
      events.push(feedback);
    });
    const entry = await add(context, '스타벅스', 12_300, '2026-11-02');

    await setCategory(context, { merchant: '스타벅스', category: 'cafe' });
    await setCategory(context, { entryId: entry.id, category: 'cafe' });
    await setCategory(context, { merchant: '없는가게', category: 'food' });

    expect(events).toEqual([]);
  });

  it('uses the entry merchant when only an entry id is given', async () => {
    const context = await setupSpending();
    const events: CardFeedback[] = [];
    context.bus.on('feedback.card', (feedback) => {
      events.push(feedback);
    });
    const entry = await add(context, '이마트', 30_000, '2026-11-05');

    await setCategory(context, { entryId: entry.id, category: 'living', remember: false });

    expect(events[0]).toMatchObject({ subject: merchantKey('이마트'), correction: 'living', label: '이마트' });
  });
});

describe('spending keyword rules from tuning', () => {
  it('applies the owner keyword rule above a built-in rule', async () => {
    const context = await setupSpending();
    await applyRule(context, '스타벅스', 'food');

    await add(context, '스타벅스 강남점', 5_000, '2026-11-03');

    expect(await sourceOf(context, '스타벅스 강남점')).toMatchObject({ category: 'food', categorySource: 'owner' });
  });

  it('applies the owner keyword rule above a model label', async () => {
    const context = await setupSpending();
    const labels = new LabelStore(context.kv, () => context.clock.now());
    await labels.setModel(merchantKey('별빛상회'), 'shopping');
    await applyRule(context, '별빛', 'groceries');

    await add(context, '별빛상회', 9_900, '2026-11-06');

    expect(await sourceOf(context, '별빛상회')).toMatchObject({ category: 'groceries', categorySource: 'owner' });
  });

  it('keeps an exact owner label above the keyword rule', async () => {
    const context = await setupSpending();
    await applyRule(context, '별빛', 'groceries');
    await setCategory(context, { merchant: '별빛상회', category: 'living' });

    await add(context, '별빛상회', 4_000, '2026-11-07');

    expect(await sourceOf(context, '별빛상회')).toMatchObject({ category: 'living', categorySource: 'owner' });
  });

  it('uses the longest matching keyword', async () => {
    const context = await setupSpending();
    await applyRule(context, '별빛', 'groceries');
    await applyRule(context, '별빛상회', 'food');

    await add(context, '별빛상회', 4_000, '2026-11-08');

    expect(await sourceOf(context, '별빛상회')).toMatchObject({ category: 'food', categorySource: 'owner' });
  });

  it('removes a rule on unmute', async () => {
    const context = await setupSpending();
    await applyRule(context, '별빛', 'groceries');
    await applyRule(context, '별빛', undefined, 'unmute');

    await add(context, '별빛상회', 4_000, '2026-11-09');

    expect(await sourceOf(context, '별빛상회')).toMatchObject({ category: 'other', categorySource: 'none' });
  });

  it('ignores an invalid category and other domains', async () => {
    const context = await setupSpending();
    await applyRule(context, '별빛', 'not-a-category');
    await context.bus.emit('tuning.apply', {
      id: 'n1',
      domain: 'notice',
      subject: '별빛',
      action: 'set',
      value: 'food',
    });

    await add(context, '별빛상회', 4_000, '2026-11-10');

    expect(await sourceOf(context, '별빛상회')).toMatchObject({ category: 'other', categorySource: 'none' });
  });
});
