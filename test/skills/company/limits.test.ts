import { describe, expect, it } from 'vitest';
import { checkIntake, effectiveLimits } from '../../../src/skills/company/limits.js';
import { companyConfig, task } from './helpers.js';

describe('checkIntake', () => {
  it('allows work below both caps', () => {
    const config = companyConfig();

    expect(checkIntake([task({ id: 'aaaaaaaa' })], 'dev', config)).toEqual({ ok: true });
  });

  it('refuses an unknown team', () => {
    expect(checkIntake([], 'nope', companyConfig())).toEqual({ ok: false, reason: 'unknown_team' });
  });

  it('refuses when the company is full', () => {
    const config = companyConfig({ limits: { ...companyConfig().limits, maxOpen: 2 } });
    const open = [task({ id: 'aaaaaaaa' }), task({ id: 'bbbbbbbb' })];

    expect(checkIntake(open, 'dev', config)).toEqual({ ok: false, reason: 'company_full' });
  });

  it('counts awaiting_accept toward the team cap', () => {
    const config = companyConfig({ limits: { ...companyConfig().limits, maxOpenPerTeam: 2 } });
    const open = [
      task({ id: 'aaaaaaaa', team: 'dev', status: 'awaiting_accept' }),
      task({ id: 'bbbbbbbb', team: 'dev', status: 'running' }),
    ];

    expect(checkIntake(open, 'dev', config)).toEqual({ ok: false, reason: 'team_full' });
  });

  it('skips team checks when no team is given', () => {
    const config = companyConfig({ limits: { ...companyConfig().limits, maxOpenPerTeam: 1, maxOpen: 5 } });
    const open = [task({ id: 'aaaaaaaa', team: 'dev' }), task({ id: 'bbbbbbbb', team: 'marketing' })];

    expect(checkIntake(open, undefined, config)).toEqual({ ok: true });
    expect(checkIntake(open, 'dev', config)).toEqual({ ok: false, reason: 'team_full' });
  });
});

describe('effectiveLimits', () => {
  it('keeps config values when there is no override', () => {
    const config = companyConfig();

    expect(effectiveLimits(config, {})).toEqual(config.limits);
  });

  it('tightens but never loosens a limit', () => {
    const config = companyConfig();

    const limits = effectiveLimits(config, {
      maxOpen: 20,
      maxOpenPerTeam: 1,
      maxAgeHours: 24,
      ownerWaitDays: 10,
      maxRevisions: 0,
      maxSteps: 8,
    });

    expect(limits).toEqual({
      maxOpen: config.limits.maxOpen,
      maxOpenPerTeam: 1,
      maxAgeHours: 24,
      ownerWaitDays: config.limits.ownerWaitDays,
      maxRevisions: 0,
      maxSteps: config.limits.maxSteps,
    });
  });
});
