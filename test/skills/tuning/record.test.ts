import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { KvDocStore } from '../../../src/core/docs/kv-doc-store.js';
import { MapKeyValueStore } from '../../core/helpers.js';
import { RECORD_DOC_ID } from '../../../src/skills/tuning/record.js';
import { FakeFeatureHealth, FakeSwitches, failure } from './fakes.js';
import { choiceMessage, DAY_MS, handlerOf, makeReplier, setupTuning, storeOf, SUNDAY } from './helpers.js';

function makeDocs(): KvDocStore {
  return new KvDocStore(new MapKeyValueStore(), () => SUNDAY);
}

describe('improvement record document', () => {
  it('logs proposed, applied, measured and reverted entries with their author kinds', async () => {
    const docs = makeDocs();
    const health = new FakeFeatureHealth([failure('mail', 'timeout', 12)]);
    const switches = new FakeSwitches(() => SUNDAY);
    const { context } = await setupTuning({
      now: SUNDAY,
      capabilities: {
        [Contracts.docs.id]: docs,
        [Contracts.featureHealth.id]: health,
        [Contracts.switches.id]: switches,
      },
    });

    await context.scheduler.run('tuning.weekly', SUNDAY);
    const proposal = (await storeOf(context).proposals())[0];
    if (proposal === undefined) throw new Error('no proposal');
    const { replier } = makeReplier();
    await handlerOf(context).handle(choiceMessage(`(choice: tuning.apply:${proposal.id})`), replier);

    health.counts = [failure('mail', 'timeout', 12)];
    const later = new Date(SUNDAY.getTime() + 14 * DAY_MS);
    await context.scheduler.run('tuning.weekly', later);
    const revert = (await storeOf(context).proposals()).find((item) => item.reason.kind === 'no_effect');
    if (revert === undefined) throw new Error('no revert proposal');
    await handlerOf(context).handle(choiceMessage(`(choice: tuning.apply:${revert.id})`), replier);

    const doc = await docs.get(RECORD_DOC_ID);
    expect(doc).toMatchObject({
      kind: 'improvement',
      scope: 'assistant',
      title: '개선 기록',
      body: '주간 조정 제안과 적용·측정·되돌림 기록이에요.',
    });
    expect(doc?.entries.map((entry) => entry.author.kind)).toEqual([
      'agent',
      'user',
      'agent',
      'agent',
      'user',
    ]);
    expect(doc?.entries[0]?.text).toContain("'mail' 기능이 이번 주 같은 이유(timeout)로 12번 실패했어요");
    expect(doc?.entries[1]?.text).toContain("적용: 'mail' 기능 7일 멈추기");
    expect(doc?.entries[2]?.text).toContain('효과 없음');
    expect(doc?.entries[4]?.text).toContain("되돌림: 'mail' 기능 다시 켜기");
    expect(doc?.entries.every((entry) => entry.sources.includes('tuning:weekly'))).toBe(true);
  });

  it('logs a declined proposal as the owner without applying anything', async () => {
    const docs = makeDocs();
    const { context, muter } = await setupTuning({
      now: SUNDAY,
      capabilities: {
        [Contracts.docs.id]: docs,
        [Contracts.featureHealth.id]: new FakeFeatureHealth([failure('mail', 'timeout', 12)]),
      },
    });
    await context.scheduler.run('tuning.weekly', SUNDAY);
    const proposal = (await storeOf(context).proposals())[0];
    if (proposal === undefined) throw new Error('no proposal');
    const { replier } = makeReplier();
    await handlerOf(context).handle(choiceMessage(`(choice: tuning.skip:${proposal.id})`), replier);

    const doc = await docs.get(RECORD_DOC_ID);
    expect(doc?.entries.map((entry) => entry.author)).toEqual([
      { kind: 'agent', id: 'skill.tuning' },
      { kind: 'user', id: 'owner' },
    ]);
    expect(doc?.entries[1]?.text).toContain("그대로 둠: 'mail' 기능 7일 멈추기");
    expect(muter.kinds.size).toBe(0);
    expect(await storeOf(context).applied()).toEqual([]);
  });

  it('works without a document store', async () => {
    const { context, notifier } = await setupTuning({
      now: SUNDAY,
      capabilities: {
        [Contracts.featureHealth.id]: new FakeFeatureHealth([failure('mail', 'timeout', 12)]),
      },
    });

    await context.scheduler.run('tuning.weekly', SUNDAY);

    expect(notifier.notices).toHaveLength(1);
  });
});
