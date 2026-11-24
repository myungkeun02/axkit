import { describe, expect, it } from 'vitest';
import { SEAT_SWEEP_JOB } from '../../../src/skills/errands/seat-watch.js';
import type { SeatWatch } from '../../../src/skills/errands/types.js';
import { TRAIN, minutes, setup } from './helpers.js';
import type { ErrandsTestContext } from './helpers.js';

async function startWatch(context: ErrandsTestContext, extra: Record<string, unknown> = {}): Promise<string> {
  const outcome = await context.ctx.tools.execute('errands.seat_watch', { ...TRAIN, ...extra });
  if (outcome.status !== 'done') throw new Error(outcome.status);
  const output = outcome.output as { started: boolean; id?: string };
  if (!output.started || output.id === undefined) throw new Error('not started');
  return output.id;
}

async function stored(context: ErrandsTestContext): Promise<SeatWatch[]> {
  return (await context.kv.get<SeatWatch[]>('seat-watches')) ?? [];
}

describe('train seat watch', () => {
  it('refuses intervals under 10 minutes and watches longer than 24 hours', async () => {
    const context = await setup();
    expect((await context.ctx.tools.execute('errands.seat_watch', { ...TRAIN, everyMinutes: 5 })).status).toBe('invalid_input');
    expect((await context.ctx.tools.execute('errands.seat_watch', { ...TRAIN, hours: 48 })).status).toBe('invalid_input');
    expect(await stored(context)).toHaveLength(0);
  });

  it('asks on a card with the frequency and the end before it starts', async () => {
    const context = await setup({ answer: 'denied' });
    const outcome = await context.ctx.tools.execute('errands.seat_watch', { ...TRAIN, hours: 6 });
    expect(outcome.status).toBe('denied');
    const card = context.confirmer.requests[0];
    expect(card?.summary).toContain('15분에 한 번만 조회하고 6시간 뒤에 저절로 끝나요');
    expect(card?.summary).toContain('예매는 직접 하라고 하실 때만');
    expect(card?.note).toContain('10분보다 자주 하지 않아요');
    expect(await stored(context)).toHaveLength(0);
  });

  it('checks no more than its interval over a whole day, with read-only searches, then ends', async () => {
    const context = await setup();
    await startWatch(context, { everyMinutes: 10, hours: 24 });
    await startWatch(context, { everyMinutes: 10, hours: 24, to: '대전' });
    const times: number[] = [];
    context.agent.now = () => times.at(-1) ?? 0;
    // the scheduler wakes every 5 minutes; also try waking every minute to prove the code, not the timer, limits it
    for (let minute = 0; minute <= 25 * 60; minute += 1) {
      times.push(minutes(context, minute).getTime());
      await context.scheduler.run(SEAT_SWEEP_JOB, minutes(context, minute));
    }
    const runs = context.agent.runTimes;
    const gaps = runs.slice(1).map((time, index) => time - (runs[index] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5 * 60_000);
    // two watches, each at most every 10 minutes, for 24 hours
    expect(runs.length).toBeLessThanOrEqual(2 * (24 * 6));
    expect(runs.length).toBeGreaterThan(200);
    expect(runs.at(-1)).toBeLessThanOrEqual(minutes(context, 24 * 60).getTime());
    for (const task of context.agent.tasks) {
      expect(task.goal).toContain('Only read the search results');
      expect(task.approvedCommit).toBeUndefined();
      expect(task.keepPage).toBeUndefined();
    }
    expect(await stored(context)).toHaveLength(0);
    expect(context.notifier.notices.map((notice) => notice.kind)).toEqual(['errands.seat_watch', 'errands.seat_watch']);
    expect(context.notifier.notices[0]?.text).toContain('빈자리 감시가 끝났어요');
  });

  it('waits a full interval for its first look', async () => {
    const context = await setup();
    await startWatch(context);
    await context.scheduler.run(SEAT_SWEEP_JOB, minutes(context, 5));
    await context.scheduler.run(SEAT_SWEEP_JOB, minutes(context, 10));
    expect(context.agent.tasks).toHaveLength(0);
    await context.scheduler.run(SEAT_SWEEP_JOB, minutes(context, 15));
    expect(context.agent.tasks).toHaveLength(1);
  });

  it('notifies once when a seat appears, offers the payment step and never books', async () => {
    const context = await setup();
    await startWatch(context);
    context.agent.results = [{ status: 'done', summary: 'SEATS: yes; TRAIN: KTX 021; DEPART: 09:30; PRICE: 59,800원' }];
    await context.scheduler.run(SEAT_SWEEP_JOB, minutes(context, 15));
    await context.scheduler.run(SEAT_SWEEP_JOB, minutes(context, 40));
    expect(context.agent.tasks).toHaveLength(1);
    expect(context.agent.tasks[0]?.approvedCommit).toBeUndefined();
    const [notice] = context.notifier.notices;
    expect(context.notifier.notices).toHaveLength(1);
    expect(notice?.kind).toBe('errands.seat');
    expect(notice?.urgent).toBe(true);
    expect(notice?.text).toContain('빈자리가 났어요');
    expect(notice?.text).toContain('· 열차: KTX 021');
    expect(notice?.text).toContain('결제 직전까지 하고 결제는 넘겨 드려요');
    expect(await stored(context)).toHaveLength(0);
  });

  it('ends the watch on a robot check or login instead of working around it', async () => {
    const context = await setup();
    await startWatch(context);
    context.agent.results = [{ status: 'needs_human', summary: 'captcha', handoff: { reason: 'captcha' } }];
    await context.scheduler.run(SEAT_SWEEP_JOB, minutes(context, 15));
    await context.scheduler.run(SEAT_SWEEP_JOB, minutes(context, 60));
    expect(context.agent.tasks).toHaveLength(1);
    expect(context.notifier.notices[0]?.text).toContain('로봇 확인을 요구해서 빈자리 감시를 멈췄어요');
    expect(await stored(context)).toHaveLength(0);
  });

  it('backs off on failures and stops after three', async () => {
    const context = await setup();
    await startWatch(context);
    context.agent.results = [{ status: 'failed', summary: 'timeout' }];
    for (let minute = 15; minute <= 12 * 60; minute += 5) await context.scheduler.run(SEAT_SWEEP_JOB, minutes(context, minute));
    expect(context.agent.tasks).toHaveLength(3);
    expect(context.notifier.notices.at(-1)?.text).toContain('감시를 멈췄어요');
  });

  it('runs at most two at once, lists and stops them, and checks nothing while stopped', async () => {
    const context = await setup({ stopped: true });
    const id = await startWatch(context);
    await startWatch(context, { to: '대구' });
    const third = await context.ctx.tools.execute('errands.seat_watch', { ...TRAIN, to: '울산' });
    expect(third.status === 'done' && (third.output as { started: boolean }).started).toBe(false);
    await context.scheduler.run(SEAT_SWEEP_JOB, minutes(context, 30));
    expect(context.agent.tasks).toHaveLength(0);

    const list = await context.ctx.tools.execute('errands.seat_watch_list', {});
    expect(list.status === 'done' && (list.output as { watches: unknown[] }).watches).toHaveLength(2);
    const stop = await context.ctx.tools.execute('errands.seat_watch_stop', { id });
    expect(stop.status === 'done' && (stop.output as { stopped: boolean }).stopped).toBe(true);
    expect(await stored(context)).toHaveLength(1);
  });
});
