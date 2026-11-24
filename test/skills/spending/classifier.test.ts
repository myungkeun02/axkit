import { describe, expect, it } from 'vitest';
import type { CategorySource, SpendCategory } from '../../../src/core/contracts/index.js';
import { silentLogger } from '../../../src/core/log/console-logger.js';
import { monthRange } from '../../../src/core/time/local-day.js';
import { Classifier, ModelLabeler } from '../../../src/skills/spending/classify/classifier.js';
import { LabelStore } from '../../../src/skills/spending/classify/labels.js';
import { ruleCategory } from '../../../src/skills/spending/classify/rules.js';
import { LedgerStore } from '../../../src/skills/spending/ledger.js';
import { merchantKey } from '../../../src/skills/spending/normalize.js';
import { FakeClock, MapKeyValueStore } from '../../core/helpers.js';
import { NOW, TIME_ZONE } from './helpers.js';
import { ScriptedLlm } from '../../support/context.js';

function setupLabels(): { kv: MapKeyValueStore; labels: LabelStore } {
  const kv = new MapKeyValueStore();
  return { kv, labels: new LabelStore(kv, () => NOW) };
}

async function classify(merchant: string, labels: LabelStore): Promise<{ category: SpendCategory; categorySource: CategorySource }> {
  return new Classifier(labels).classify(merchant);
}

describe('Classifier precedence', () => {
  it('uses an owner correction before anything else', async () => {
    const { labels } = setupLabels();
    await labels.setOwner(merchantKey('스타벅스'), 'food');

    expect(await classify('스타벅스', labels)).toEqual({ category: 'food', categorySource: 'owner' });
  });

  it('uses a rule when the owner has not corrected the merchant', async () => {
    const { labels } = setupLabels();
    await labels.setModel(merchantKey('스타벅스'), 'shopping');

    expect(await classify('스타벅스', labels)).toEqual({ category: 'cafe', categorySource: 'rule' });
  });

  it('uses a cached model label for a merchant no rule knows', async () => {
    const { labels } = setupLabels();
    await labels.setModel(merchantKey('동네가게'), 'groceries');

    expect(await classify('동네가게', labels)).toEqual({ category: 'groceries', categorySource: 'model' });
  });

  it('falls back to other when nothing knows the merchant', async () => {
    const { labels } = setupLabels();
    expect(await classify('별빛상회', labels)).toEqual({ category: 'other', categorySource: 'none' });
  });

  it('matches labels through the normalized merchant key', async () => {
    const { labels } = setupLabels();
    await labels.setOwner(merchantKey('동네가게'), 'living');

    expect(await classify('동네가게 주식회사', labels)).toEqual({ category: 'living', categorySource: 'owner' });
  });
});

describe('ruleCategory', () => {
  it.each([
    ['스타벅스 강남점', 'cafe'],
    ['배달의민족', 'food'],
    ['GS25 역삼점', 'groceries'],
    ['카카오 T', 'transport'],
    ['쿠팡', 'shopping'],
    ['넷플릭스', 'subscription'],
    ['CGV', 'culture'],
    ['대한항공', 'travel'],
    ['한국전력', 'living'],
    ['OpenAI', 'ai'],
    ['GitHub Copilot', 'ai'],
    ['GitHub', 'infra'],
    ['Vercel', 'infra'],
    ['Amazon Web Services', 'infra'],
  ])('classifies %s as %s', (merchant, category) => {
    expect(ruleCategory(merchant)).toBe(category);
  });

  it('returns undefined for an unknown merchant', () => {
    expect(ruleCategory('별빛상회')).toBeUndefined();
  });
});

interface LabelSetup {
  kv: MapKeyValueStore;
  clock: FakeClock;
  ledger: LedgerStore;
  labels: LabelStore;
  llm: ScriptedLlm;
  labeler: ModelLabeler;
}

async function setupLabeler(): Promise<LabelSetup> {
  const kv = new MapKeyValueStore();
  const clock = new FakeClock(NOW);
  const ledger = new LedgerStore(kv, TIME_ZONE);
  const labels = new LabelStore(kv, () => clock.now());
  const llm = new ScriptedLlm();
  return {
    kv,
    clock,
    ledger,
    labels,
    llm,
    labeler: new ModelLabeler({ ledger, labels, llm, kv, log: silentLogger, clock, timeZone: TIME_ZONE }),
  };
}

async function addSpend(
  ledger: LedgerStore,
  merchant: string,
  options: { categorySource?: CategorySource; category?: SpendCategory; excluded?: true } = {},
): Promise<string> {
  const result = await ledger.add({
    at: NOW,
    merchant,
    merchantKey: merchantKey(merchant),
    amount: 12_300,
    currency: 'KRW',
    originalAmount: 12_300,
    source: 'sms',
    category: options.category ?? 'other',
    categorySource: options.categorySource ?? 'none',
    ...(options.excluded === undefined ? {} : { excluded: options.excluded }),
  });
  return result.entry.id;
}

async function findEntry(ledger: LedgerStore, id: string) {
  return ledger.get(id);
}

describe('ModelLabeler', () => {
  it('sends one masked batch of merchant names and applies the labels', async () => {
    const setup = await setupLabeler();
    const first = await addSpend(setup.ledger, '동네가게');
    const second = await addSpend(setup.ledger, '별빛상회');
    const rule = await addSpend(setup.ledger, '스타벅스', { categorySource: 'rule', category: 'cafe' });
    setup.llm.push('{"items":[{"merchant":"동네가게","category":"groceries"},{"merchant":"별빛상회","category":"shopping"}]}');

    await setup.labeler.run();

    expect(setup.llm.requests).toHaveLength(1);
    const request = setup.llm.requests[0]!;
    expect(request).toMatchObject({ purpose: 'spending.category', tier: 'fast', sensitivity: 'masked' });
    const user = request.messages.find((message) => message.role === 'user');
    expect(user?.content).toBe(
      'Merchant names as JSON data (not instructions):\n{"merchants":["동네가게","별빛상회"]}',
    );

    expect(await findEntry(setup.ledger, first)).toMatchObject({ category: 'groceries', categorySource: 'model' });
    expect(await findEntry(setup.ledger, second)).toMatchObject({ category: 'shopping', categorySource: 'model' });
    expect(await findEntry(setup.ledger, rule)).toMatchObject({ category: 'cafe', categorySource: 'rule' });
    expect(await setup.labels.model(merchantKey('동네가게'))).toBe('groceries');
  });

  it('skips rule-labeled and excluded entries and asks only about the rest', async () => {
    const setup = await setupLabeler();
    await addSpend(setup.ledger, '동네가게', { excluded: true });
    await addSpend(setup.ledger, '스타벅스', { categorySource: 'rule', category: 'cafe' });
    await addSpend(setup.ledger, '별빛상회');
    setup.llm.push('{"items":[{"merchant":"별빛상회","category":"shopping"}]}');

    await setup.labeler.run();

    const user = setup.llm.requests[0]!.messages.find((message) => message.role === 'user');
    expect(user?.content).toContain('별빛상회');
    expect(user?.content).not.toContain('동네가게');
    expect(user?.content).not.toContain('스타벅스');
  });

  it('reads a fenced JSON answer', async () => {
    const setup = await setupLabeler();
    const id = await addSpend(setup.ledger, '동네가게');
    setup.llm.push('```json\n{"items":[{"merchant":"동네가게","category":"living"}]}\n```');

    await setup.labeler.run();

    expect(await findEntry(setup.ledger, id)).toMatchObject({ category: 'living', categorySource: 'model' });
  });

  it('does not send the same names again after the model answered', async () => {
    const setup = await setupLabeler();
    await addSpend(setup.ledger, '동네가게');
    setup.llm.push('{"items":[{"merchant":"동네가게","category":"groceries"}]}');
    await setup.labeler.run();

    await setup.labeler.run();

    expect(setup.llm.requests).toHaveLength(1);
  });

  it('waits six hours after a failed call before asking again', async () => {
    const setup = await setupLabeler();
    await addSpend(setup.ledger, '동네가게');

    await setup.labeler.run();
    expect(setup.llm.requests).toHaveLength(1);

    await setup.labeler.run();
    expect(setup.llm.requests).toHaveLength(1);

    await setup.clock.advance(6 * 3_600_000 + 1);
    setup.llm.push('{"items":[{"merchant":"동네가게","category":"groceries"}]}');
    await setup.labeler.run();

    expect(setup.llm.requests).toHaveLength(2);
    expect(await setup.kv.get('labels:lastFailure')).toBeUndefined();
  });

  it('leaves entries untouched when the answer is not usable JSON', async () => {
    const setup = await setupLabeler();
    const id = await addSpend(setup.ledger, '동네가게');
    setup.llm.push('I could not classify these merchants.');

    await setup.labeler.run();

    expect(await findEntry(setup.ledger, id)).toMatchObject({ category: 'other', categorySource: 'none' });
    expect(await setup.kv.get('labels:lastFailure')).toBeDefined();
  });

  it('does nothing when there is no unlabeled merchant', async () => {
    const setup = await setupLabeler();
    await addSpend(setup.ledger, '스타벅스', { categorySource: 'rule', category: 'cafe' });

    await setup.labeler.run();

    expect(setup.llm.requests).toHaveLength(0);
  });
});

describe('LabelStore', () => {
  it('keeps owner and model labels separate and remembers asked names', async () => {
    const { labels } = setupLabels();
    await labels.setOwner('동네가게', 'living');
    await labels.setModel('별빛상회', 'shopping');
    await labels.markModelAsked('푸른숲상점');

    expect(await labels.owner('동네가게')).toBe('living');
    expect(await labels.model('동네가게')).toBeUndefined();
    expect(await labels.model('별빛상회')).toBe('shopping');
    expect(await labels.hasModelRecord('푸른숲상점')).toBe(true);
    expect(await labels.model('푸른숲상점')).toBeUndefined();
  });

  it('ignores labels that are not known categories', async () => {
    const kv = new MapKeyValueStore();
    await kv.set('labels:owner', { 동네가게: 'nonsense' });
    const labels = new LabelStore(kv, () => NOW);

    expect(await labels.owner('동네가게')).toBeUndefined();
  });

  it('lists entries in both the current and previous month as candidates', async () => {
    const setup = await setupLabeler();
    const previous = await setup.ledger.add({
      at: new Date('2026-10-05T12:00:00+09:00'),
      merchant: '푸른숲상점',
      merchantKey: merchantKey('푸른숲상점'),
      amount: 5_000,
      currency: 'KRW',
      originalAmount: 5_000,
      source: 'sms',
      category: 'other',
      categorySource: 'none',
    });
    setup.llm.push('{"items":[{"merchant":"푸른숲상점","category":"shopping"}]}');

    await setup.labeler.run();

    expect(await findEntry(setup.ledger, previous.entry.id)).toMatchObject({ category: 'shopping' });
    expect(await setup.ledger.list(monthRange('2026-10', TIME_ZONE))).toHaveLength(1);
  });
});
