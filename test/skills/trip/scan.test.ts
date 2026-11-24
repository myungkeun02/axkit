import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { LlmGateway } from '../../../src/core/llm/types.js';
import type { TripSegment } from '../../../src/skills/trip/types.js';
import { ScriptedLlm } from '../../support/context.js';
import { FakeMail, FakeNotifier, mailMessage, NOW, segment, setupTrip, storedSegments } from './helpers.js';

function bookingJson(overrides: Record<string, unknown> = {}, cancelled = false): string {
  return JSON.stringify({
    segments: [
      {
        kind: 'flight',
        title: 'KE123',
        start: '2026-12-01T08:30',
        from: 'ICN',
        to: 'NRT',
        reference: 'ABC123',
        ...overrides,
      },
    ],
    cancelled,
  });
}

async function scanSetup(options: {
  mail: FakeMail;
  llm?: LlmGateway;
  notifier?: FakeNotifier;
  config?: Record<string, unknown>;
  seed?: TripSegment[];
}) {
  const notifier = options.notifier ?? new FakeNotifier();
  const context = await setupTrip({
    now: NOW,
    capabilities: {
      [Contracts.notifier.id]: notifier,
      [Contracts.mailRead.id]: options.mail,
    },
    ...(options.llm !== undefined ? { llm: options.llm } : {}),
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.seed !== undefined ? { seed: options.seed } : {}),
  });
  return { context, notifier };
}

describe('trip.scan', () => {
  it('stores a booking once and widens only the first lookback', async () => {
    const mail = new FakeMail([mailMessage({ id: 'm1' })]);
    const llm = new ScriptedLlm([bookingJson()]);
    const { context } = await scanSetup({ mail, llm });

    await context.scheduler.run('trip.scan', NOW);

    const stored = await storedSegments(context);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      mailId: 'm1',
      kind: 'flight',
      title: 'KE123',
      start: '2026-12-01T08:30:00+09:00',
      startText: '2026-12-01T08:30',
      from: 'ICN',
      to: 'NRT',
      reference: 'ABC123',
    });
    expect(stored[0]?.id).toHaveLength(8);
    expect(llm.requests).toHaveLength(1);
    expect(mail.queries[0]).toMatchObject({ sinceHours: 720, limit: 20 });
    expect(mail.queries[0]?.text).toContain('예약 확인');

    await context.scheduler.run('trip.scan', NOW);

    expect(llm.requests).toHaveLength(1);
    expect(mail.queries[1]?.sinceHours).toBe(72);
  });

  it('makes at most ten model calls per run and continues on the next run', async () => {
    const messages = Array.from({ length: 12 }, (_, index) =>
      mailMessage({ id: `m${index}`, subject: `예약 확인 ${index}`, body: `예약번호 ABC${index}` }),
    );
    const script = Array.from({ length: 12 }, (_, index) =>
      bookingJson({
        title: `KE${index}`,
        start: `2026-12-${String(index + 1).padStart(2, '0')}T08:30`,
        reference: `ABC${index}`,
      }),
    );
    const mail = new FakeMail(messages);
    const llm = new ScriptedLlm(script);
    const { context } = await scanSetup({ mail, llm });

    await context.scheduler.run('trip.scan', NOW);
    expect(llm.requests).toHaveLength(10);
    expect(await storedSegments(context)).toHaveLength(10);

    await context.scheduler.run('trip.scan', NOW);
    expect(llm.requests).toHaveLength(12);
    expect(await storedSegments(context)).toHaveLength(12);
  });

  it('stores nothing and does not retry unusable JSON', async () => {
    const mail = new FakeMail([mailMessage({ id: 'm1' })]);
    const llm = new ScriptedLlm(['not json']);
    const { context } = await scanSetup({ mail, llm });

    await context.scheduler.run('trip.scan', NOW);
    expect(await storedSegments(context)).toHaveLength(0);

    await context.scheduler.run('trip.scan', NOW);
    expect(llm.requests).toHaveLength(1);
    expect(await storedSegments(context)).toHaveLength(0);
  });

  it('retries a mail when the model gateway fails', async () => {
    const mail = new FakeMail([mailMessage({ id: 'm1' })]);
    const llm = new ScriptedLlm([]);
    const { context } = await scanSetup({ mail, llm });

    await context.scheduler.run('trip.scan', NOW);
    expect(await storedSegments(context)).toHaveLength(0);

    llm.push(bookingJson());
    await context.scheduler.run('trip.scan', NOW);

    expect(llm.requests).toHaveLength(2);
    expect(await storedSegments(context)).toHaveLength(1);
  });

  it('removes the matching segment on a cancellation and notices once', async () => {
    const seed = [
      segment({ id: 's1', title: 'KE123', reference: 'ABC123', start: '2026-12-01T08:30:00+09:00' }),
      segment({ id: 's2', title: 'KE999', reference: 'ZZZ999', start: '2026-12-05T08:30:00+09:00' }),
    ];
    const mail = new FakeMail([mailMessage({ id: 'm1', subject: '예약 취소 안내', body: '예약이 취소되었습니다' })]);
    const llm = new ScriptedLlm([
      JSON.stringify({
        segments: [{ kind: 'flight', title: 'KE123', start: '2026-12-01T08:30', reference: 'ABC123' }],
        cancelled: true,
      }),
    ]);
    const { context, notifier } = await scanSetup({ mail, llm, seed });

    await context.scheduler.run('trip.scan', NOW);

    expect((await storedSegments(context)).map((item) => item.id)).toEqual(['s2']);
    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]).toMatchObject({ kind: 'trip.cancelled', text: expect.stringContaining('예약 취소를 반영했어요') });

    await context.scheduler.run('trip.scan', NOW);
    expect(notifier.notices).toHaveLength(1);
    expect(llm.requests).toHaveLength(1);
  });

  it('does not call the model for unrelated mail but marks it seen', async () => {
    const mail = new FakeMail([mailMessage({ id: 'm1', subject: '주간 회의 자료', body: '내일 회의 준비' })]);
    const llm = new ScriptedLlm([]);
    const { context } = await scanSetup({ mail, llm });

    await context.scheduler.run('trip.scan', NOW);

    expect(llm.requests).toHaveLength(0);
    expect(await context.kv.get<string[]>('seen')).toEqual(['m1']);
  });

  it('prunes trips that ended more than sixty days ago', async () => {
    const seed = [
      segment({ id: 'old', title: 'old flight', start: '2026-08-01T08:30:00+09:00', startText: '2026-08-01T08:30' }),
      segment({ id: 'new', title: 'new flight', start: '2026-12-01T08:30:00+09:00' }),
    ];
    const mail = new FakeMail([]);
    const { context } = await scanSetup({ mail, seed });

    await context.scheduler.run('trip.scan', NOW);

    expect((await storedSegments(context)).map((item) => item.id)).toEqual(['new']);
  });

  it('survives a mail search failure', async () => {
    const mail = new FakeMail([]);
    mail.failSearch = true;
    const { context } = await scanSetup({ mail });

    await expect(context.scheduler.run('trip.scan', NOW)).resolves.toBeUndefined();
  });

  it('registers no scan job when scanning is off', async () => {
    const context = await setupTrip({ config: { scan: false } });

    expect(context.scheduler.jobs.has('trip.scan')).toBe(false);
    expect(context.scheduler.jobs.has('trip.checklist')).toBe(true);
    expect(context.scheduler.jobs.get('trip.checklist')?.schedule).toEqual({ kind: 'daily', at: '09:00' });
  });
});
