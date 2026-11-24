import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from '../../../src/core/conversation/types.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { daySkill } from '../../../src/skills/day/plugin.js';
import { createTestContext } from '../../support/context.js';
import { FakeNotifier, FakePhone, FakeReplier } from './helpers.js';

function at(hhmm: string): Date {
  return new Date(`2026-11-17T${hhmm}:00+09:00`);
}

function incoming(text: string, fromOwner = true): IncomingMessage {
  return {
    id: 'in-1',
    conversation: { channelId: 'discord', address: 'dm' },
    authorId: 'owner',
    fromOwner,
    text,
    receivedAt: at('08:30'),
  };
}

async function setup(options: { now?: Date; health?: Record<string, unknown>; phone?: FakePhone } = {}) {
  const now = options.now ?? at('15:00');
  const notifier = new FakeNotifier();
  const phone = options.phone ?? new FakePhone({ lat: 37.5, lng: 127, at: now }, { steps: 2000 });
  const context = createTestContext({
    now,
    config: { health: options.health ?? {} },
    capabilities: {
      [Contracts.notifier.id]: notifier,
      [Contracts.phoneSignals.id]: phone,
    },
  });
  await daySkill().setup(context.ctx);
  const handler = context.handlers.find((candidate) => candidate.id === 'day.health.meds');
  return { notifier, phone, handler, ...context };
}

describe('day.health steps', () => {
  it('nudges once at the first sweep after 15:00 when steps are low', async () => {
    const { notifier, scheduler } = await setup();

    await scheduler.run('day.health', at('15:00'));
    await scheduler.run('day.health', at('15:30'));

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]).toMatchObject({ kind: 'day.health.steps', text: expect.stringContaining('2,000') });
  });

  it('nudges at the 19:00 threshold too', async () => {
    const { notifier, scheduler } = await setup({
      phone: new FakePhone(undefined, { steps: 3000 }),
    });
    await scheduler.run('day.health', at('19:00'));
    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.text).toContain('3,000보');
  });

  it('does not nudge when the goal ratio is met', async () => {
    const { notifier, scheduler } = await setup({
      phone: new FakePhone(undefined, { steps: 6000 }),
    });
    await scheduler.run('day.health', at('15:00'));
    expect(notifier.notices).toHaveLength(0);
  });

  it('waits for phone data instead of nudging blindly', async () => {
    const phone = new FakePhone(undefined, {});
    const { notifier, scheduler } = await setup({ phone });

    await scheduler.run('day.health', at('15:00'));
    expect(notifier.notices).toHaveLength(0);

    phone.totals = { steps: 1000 };
    await scheduler.run('day.health', at('15:30'));
    expect(notifier.notices).toHaveLength(1);
  });
});

describe('day.health water', () => {
  it('nudges inside the window no more often than everyMinutes', async () => {
    const { notifier, scheduler } = await setup({
      now: at('09:00'),
      health: { water: { everyMinutes: 120, from: '10:00', to: '20:00' } },
    });

    await scheduler.run('day.health', at('09:30'));
    expect(notifier.notices).toHaveLength(0);

    await scheduler.run('day.health', at('10:00'));
    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.kind).toBe('day.health.water');
    expect(notifier.notices[0]?.urgent).toBeUndefined();

    await scheduler.run('day.health', at('11:00'));
    expect(notifier.notices).toHaveLength(1);

    await scheduler.run('day.health', at('12:00'));
    expect(notifier.notices).toHaveLength(2);
  });

  it('stays quiet outside the window', async () => {
    const { notifier, scheduler } = await setup({
      health: { water: { everyMinutes: 60, from: '10:00', to: '20:00' } },
    });
    await scheduler.run('day.health', at('21:00'));
    expect(notifier.notices.filter((notice) => notice.kind === 'day.health.water')).toHaveLength(0);
  });
});

describe('day.health medicine', () => {
  const medHealth = { meds: [{ name: '영양제', at: '08:00' }] };

  it('sends one urgent reminder with done and snooze choices', async () => {
    const { notifier, scheduler } = await setup({ now: at('08:30'), health: medHealth });

    await scheduler.run('day.health', at('08:30'));

    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice?.kind).toBe('day.health.med');
    expect(notice?.urgent).toBe(true);
    expect(notice?.text).toBe('약 먹을 시간이에요: 영양제');
    expect(notice?.choices).toEqual([
      { id: 'day.med_done:0:2026-11-17', label: '먹었어요' },
      { id: 'day.med_snooze:0:2026-11-17', label: '10분 뒤' },
    ]);
  });

  it('marks the medicine done and never reminds again that day', async () => {
    const { handler, scheduler, notifier } = await setup({ now: at('08:30'), health: medHealth });
    const replier = new FakeReplier();

    await scheduler.run('day.health', at('08:30'));
    expect(handler).toBeDefined();
    await handler!.handle(incoming('(choice: day.med_done:0:2026-11-17)'), replier);
    await scheduler.run('day.health', at('09:00'));

    expect(notifier.notices).toHaveLength(1);
    expect(replier.replies).toHaveLength(0);
  });

  it('re-sends a snoozed reminder after ten minutes', async () => {
    const { handler, scheduler, notifier } = await setup({ now: at('08:30'), health: medHealth });
    const replier = new FakeReplier();

    await scheduler.run('day.health', at('08:30'));
    await handler!.handle(incoming('(choice: day.med_snooze:0:2026-11-17)'), replier);
    expect(replier.replies[0]?.message.text).toBe('10분 뒤에 다시 알려드릴게요.');

    await scheduler.run('day.health.snooze', new Date(at('08:30').getTime() + 9 * 60_000));
    expect(notifier.notices).toHaveLength(1);

    await scheduler.run('day.health.snooze', new Date(at('08:30').getTime() + 11 * 60_000));
    expect(notifier.notices).toHaveLength(2);
    expect(notifier.notices[1]?.urgent).toBe(true);
  });

  it('passes on non-owner button presses and foreign choices', async () => {
    const { handler, scheduler, notifier } = await setup({ now: at('08:30'), health: medHealth });
    const replier = new FakeReplier();

    await scheduler.run('day.health', at('08:30'));
    await expect(handler!.handle(incoming('(choice: day.med_done:0:2026-11-17)', false), replier)).resolves.toBe('pass');
    await expect(handler!.handle(incoming('(choice: day.med_done:9:2026-11-17)'), replier)).resolves.toBe('pass');
    expect(replier.replies).toHaveLength(0);
    expect(notifier.notices).toHaveLength(1);
  });

  it('does not add a snooze job when no medicine is configured', async () => {
    const { scheduler } = await setup({ now: at('08:30'), health: {} });
    expect(scheduler.jobs.has('day.health.snooze')).toBe(false);
  });
});
