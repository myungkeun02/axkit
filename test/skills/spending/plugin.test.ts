import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { monthRange } from '../../../src/core/time/local-day.js';
import { spendingSkill } from '../../../src/skills/spending/plugin.js';
import { notice, setupSpending, spendReader, TIME_ZONE } from './helpers.js';

describe('spendingSkill manifest', () => {
  it('is a skill with a stable id and no required capabilities', () => {
    const manifest = spendingSkill().manifest;

    expect(manifest).toMatchObject({ id: 'skill.spending', kind: 'skill', title: 'Spending' });
    expect(manifest.needs).toBeUndefined();
  });
});

describe('spend.read capability', () => {
  it('returns the home currency from the config', async () => {
    const korean = await setupSpending();
    const english = await setupSpending({ assistant: { language: 'en' } });

    expect(spendReader(korean).homeCurrency()).toBe('KRW');
    expect(spendReader(english).homeCurrency()).toBe('USD');
  });

  it('uses the Korean defaults when the config is invalid', async () => {
    const context = await setupSpending({ config: { homeCurrency: 'nope', mailScanSeconds: 1 } });

    expect(spendReader(context).homeCurrency()).toBe('KRW');
  });

  it('leaves excluded entries out of the reader', async () => {
    const context = await setupSpending();
    await context.bus.emit('money.notice', notice({
      text: '신한카드(1234)승인 12,300원 11/02 12:34 스타벅스',
    }));
    const reader = spendReader(context);
    const [entry] = await reader.entries(monthRange('2026-11', TIME_ZONE));

    await context.ctx.tools.execute('spending.exclude', { entryId: entry?.id });

    expect(await reader.entries(monthRange('2026-11', TIME_ZONE))).toHaveLength(0);
    expect(context.provided.get(Contracts.spendRead.id)).toBe(reader);
  });
});
