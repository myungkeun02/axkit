import { describe, expect, it } from 'vitest';
import { daySkill } from '../../../src/skills/day/plugin.js';
import { createTestContext } from '../../support/context.js';
import type { TestContextOptions } from '../../support/context.js';
import { NOW } from './helpers.js';

async function setup(options: TestContextOptions = {}) {
  const context = createTestContext({ now: NOW, ...options });
  await daySkill().setup(context.ctx);
  return context;
}

describe('daySkill', () => {
  it('registers every feature by default at its configured time', async () => {
    const { scheduler, handlers } = await setup();

    expect(scheduler.jobs.get('day.prep')?.schedule).toEqual({ kind: 'daily', at: '20:00' });
    expect(scheduler.jobs.get('day.travel')?.schedule).toEqual({ kind: 'every', seconds: 300 });
    expect(scheduler.jobs.get('day.close')?.schedule).toEqual({ kind: 'daily', at: '21:30' });
    expect(scheduler.jobs.get('day.replies')?.schedule).toEqual({ kind: 'daily', at: '17:30' });
    expect(scheduler.jobs.get('day.health')?.schedule).toEqual({ kind: 'every', seconds: 1800 });
    expect(scheduler.jobs.has('day.health.snooze')).toBe(false);
    expect(handlers.map((handler) => handler.id)).toContain('day.replies.draft');
  });

  it('reads configured times and the travel buffer', async () => {
    const { scheduler } = await setup({
      config: { prepAt: '19:00', closeAt: '22:10', repliesAt: '16:45', travelBufferMinutes: 25 },
    });

    expect(scheduler.jobs.get('day.prep')?.schedule).toEqual({ kind: 'daily', at: '19:00' });
    expect(scheduler.jobs.get('day.close')?.schedule).toEqual({ kind: 'daily', at: '22:10' });
    expect(scheduler.jobs.get('day.replies')?.schedule).toEqual({ kind: 'daily', at: '16:45' });
  });

  it('leaves switched-off features unregistered', async () => {
    const { scheduler, handlers } = await setup({
      config: { prep: false, travel: false, meetLinks: false, close: false, replies: false, voice: false, health: false },
    });

    expect(scheduler.jobs.size).toBe(0);
    expect(handlers).toHaveLength(0);
  });

  it('registers medicine jobs and the button handler when meds are configured', async () => {
    const { scheduler, handlers } = await setup({
      config: { health: { meds: [{ name: '영양제', at: '08:00' }] } },
    });

    expect(scheduler.jobs.has('day.health.snooze')).toBe(true);
    expect(handlers.map((handler) => handler.id)).toContain('day.health.meds');
  });

  it('treats health: false as switched off', async () => {
    const { scheduler } = await setup({ config: { health: false } });
    expect(scheduler.jobs.has('day.health')).toBe(false);
  });

  it('falls back to defaults on invalid config and keeps running', async () => {
    const { scheduler } = await setup({ config: { prepAt: '25:00' } });
    expect(scheduler.jobs.get('day.prep')?.schedule).toEqual({ kind: 'daily', at: '20:00' });
  });
});
