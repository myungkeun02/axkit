import { describe, expect, it } from 'vitest';
import type { TuningChange } from '../../../src/core/contracts/index.js';
import { CompanyOverrides, listenOverrides } from '../../../src/skills/company/overrides.js';
import { submitRequest } from '../../../src/skills/company/intake.js';
import type { IntakeDeps } from '../../../src/skills/company/intake.js';
import { intakeTexts } from '../../../src/skills/company/locale-intake.js';
import { KvTaskRepository } from '../../../src/skills/company/store.js';
import { createTestContext } from '../../support/context.js';
import { companyConfig, NOW } from './helpers.js';

function change(partial: Partial<TuningChange>): TuningChange {
  return { id: 'change-1', domain: 'company.limits', subject: 'maxOpen', action: 'set', ...partial };
}

function setup() {
  const context = createTestContext({ now: NOW });
  const overrides = new CompanyOverrides(context.kv);
  const config = companyConfig();
  const repo = new KvTaskRepository(context.kv, () => context.clock.now());
  return { context, overrides, config, repo };
}

describe('CompanyOverrides', () => {
  it('tightens effective limits but never loosens config', async () => {
    const { overrides, config } = setup();

    await overrides.apply(change({ subject: 'maxOpen', value: '2' }));
    expect((await overrides.limits(config)).maxOpen).toBe(2);

    await overrides.apply(change({ subject: 'maxOpen', value: '20' }));
    expect((await overrides.limits(config)).maxOpen).toBe(config.limits.maxOpen);

    await overrides.apply(change({ subject: 'maxOpen', action: 'unmute' }));
    expect((await overrides.limits(config)).maxOpen).toBe(config.limits.maxOpen);
  });

  it('ignores other domains, unknown keys and non-numeric values', async () => {
    const { overrides, config } = setup();

    await overrides.apply(change({ domain: 'notice', subject: 'maxOpen', value: '1' }));
    await overrides.apply(change({ subject: 'reportAt', value: '1' }));
    await overrides.apply(change({ subject: 'maxSteps', value: 'many' }));
    await overrides.apply(change({ subject: 'maxSteps', value: '-2' }));

    expect(await overrides.load()).toEqual({});
    expect((await overrides.limits(config)).maxOpen).toBe(config.limits.maxOpen);
  });

  it('applies changes from the tuning.apply event', async () => {
    const { context, overrides, config } = setup();
    const unsubscribe = listenOverrides(context.ctx, overrides);

    await context.bus.emit('tuning.apply', change({ subject: 'maxOpenPerTeam', value: '1' }));

    expect((await overrides.limits(config)).maxOpenPerTeam).toBe(1);
    unsubscribe();
    await context.bus.emit('tuning.apply', change({ subject: 'maxOpen', value: '1' }));
    expect((await overrides.limits(config)).maxOpen).toBe(config.limits.maxOpen);
  });

  it('makes intake refuse when the tightened cap is reached', async () => {
    const { context, overrides, config, repo } = setup();
    await overrides.apply(change({ subject: 'maxOpen', value: '1' }));
    await repo.create({ team: 'dev', title: '이미 하는 일', request: '이미 하는 일', source: 'owner', status: 'queued' });
    const deps: IntakeDeps = {
      ctx: context.ctx,
      repo,
      config,
      limits: () => overrides.limits(config),
      texts: intakeTexts('ko'),
      classify: async () => undefined,
    };

    const result = await submitRequest(deps, { request: '버그를 고쳐 주세요', source: 'owner' });

    expect(result).toEqual({
      status: 'refused',
      message: '지금 회사 일이 1건 열려 있어 더 받지 않을게요. 끝나거나 닫히면 다시 맡겨 주세요.',
    });
  });
});
