import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { Fact, HealthFinding } from '../../../src/core/contracts/index.js';
import { FakeHealthRegistry, FakeMemoryExpiry, FakeUsage, purpose } from './fakes.js';
import { NOW, setupTuning, SUNDAY } from './helpers.js';

const FINDINGS: HealthFinding[] = [0, 1, 2, 3, 4, 5].map((index) => ({
  id: `check.${index}`,
  area: 'ops',
  ok: false,
  line: `finding ${index}`,
}));

const EXPIRED: Fact = {
  id: 'f1',
  subject: 'owner',
  text: 'the move',
  source: { kind: 'chat' },
  at: NOW.toISOString(),
  strength: 0.4,
  expired: true,
};

describe('weekly checks section', () => {
  it('reports findings, model failure rates and expired facts without proposals', async () => {
    const { context, notifier } = await setupTuning({
      now: SUNDAY,
      capabilities: {
        [Contracts.health.id]: new FakeHealthRegistry([...FINDINGS, { id: 'ok', area: 'ops', ok: true, line: 'fine' }]),
        [Contracts.usage.id]: new FakeUsage([
          purpose('company.lead', 15, 5),
          purpose('quiet', 100, 10),
          purpose('tiny', 2, 1),
        ]),
        [Contracts.memoryExpiry.id]: new FakeMemoryExpiry([EXPIRED]),
      },
    });

    await context.scheduler.run('tuning.weekly', SUNDAY);

    const notice = notifier.notices[0];
    expect(notice?.kind).toBe('tuning.weekly');
    expect(notice?.text).toContain('점검');
    expect(notice?.text).toContain('- finding 0');
    expect(notice?.text).toContain('- finding 4');
    expect(notice?.text).not.toContain('- finding 5');
    expect(notice?.text).not.toContain('- fine');
    expect(notice?.text).toContain("'company.lead' 모델 호출 15번 중 5번 실패");
    expect(notice?.text).not.toContain("'quiet'");
    expect(notice?.text).not.toContain("'tiny'");
    expect(notice?.text).toContain('끝 조건이 지난 사실 1개를 다시 확인해 주세요');
    expect(notice?.choices).toBeUndefined();
  });

  it('omits the model line below the failure-rate threshold', async () => {
    const { context, notifier } = await setupTuning({
      now: SUNDAY,
      capabilities: {
        [Contracts.health.id]: new FakeHealthRegistry([
          { id: 'switch.long-paused:mail', area: 'switch', ok: false, line: 'mail is paused' },
        ]),
        [Contracts.usage.id]: new FakeUsage([purpose('company.lead', 20, 4)]),
      },
    });

    await context.scheduler.run('tuning.weekly', SUNDAY);

    expect(notifier.notices[0]?.text).toContain('점검');
    expect(notifier.notices[0]?.text).toContain('- mail is paused');
    expect(notifier.notices[0]?.text).not.toContain('모델 호출');
  });

  it('sends nothing when no section has content', async () => {
    const { context, notifier } = await setupTuning({
      now: SUNDAY,
      capabilities: {
        [Contracts.health.id]: new FakeHealthRegistry([{ id: 'ok', area: 'ops', ok: true, line: 'fine' }]),
        [Contracts.usage.id]: new FakeUsage([]),
        [Contracts.memoryExpiry.id]: new FakeMemoryExpiry([]),
      },
    });

    await context.scheduler.run('tuning.weekly', SUNDAY);

    expect(notifier.notices).toEqual([]);
  });
});
