import { describe, expect, it } from 'vitest';
import { tuningSkill } from '../../../src/skills/tuning/plugin.js';
import { DAY_MS, feedback, NOW, setupTuning, storeOf } from './helpers.js';

describe('tuningSkill manifest', () => {
  it('is a skill with a stable id and title', () => {
    expect(tuningSkill().manifest).toEqual({
      id: 'skill.tuning',
      kind: 'skill',
      title: 'Self-tuning (weekly suggestions from your corrections)',
    });
  });
});

describe('tuning setup', () => {
  it('registers a daily job at the configured time that acts only on the configured weekday', async () => {
    const { context } = await setupTuning();

    const job = context.scheduler.jobs.get('tuning.weekly');
    expect(job?.schedule).toEqual({ kind: 'daily', at: '19:00' });
    expect(context.handlers.map((handler) => handler.id)).toEqual(['tuning.buttons']);
    expect(context.registry.get('tuning.list')?.effects).toEqual(['read']);
    expect(context.registry.get('tuning.undo')?.effects).toEqual(['write']);
  });

  it('honors a configured weekday and time', async () => {
    const { context } = await setupTuning({ config: { weekday: 3, at: '08:30' } });

    expect(context.scheduler.jobs.get('tuning.weekly')?.schedule).toEqual({ kind: 'daily', at: '08:30' });
  });

  it('falls back to the defaults for invalid config', async () => {
    const { context } = await setupTuning({ config: { weekday: 9, at: '25:00' } });

    expect(context.scheduler.jobs.get('tuning.weekly')?.schedule).toEqual({ kind: 'daily', at: '19:00' });
  });

  it('appends card feedback without a message body', async () => {
    const { context } = await setupTuning();
    await context.bus.emit('feedback.card', feedback('notice', 'chat.replies', 'rejected', {
      at: new Date(NOW.getTime() - DAY_MS),
    }));

    const stored = await storeOf(context).since(new Date(NOW.getTime() - 2 * DAY_MS));

    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual({
      domain: 'notice',
      subject: 'chat.replies',
      verdict: 'rejected',
      at: new Date(NOW.getTime() - DAY_MS).toISOString(),
    });
    expect(stored[0]).not.toHaveProperty('body');
    expect(stored[0]).not.toHaveProperty('text');
  });
});
