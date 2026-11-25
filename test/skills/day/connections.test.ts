import { describe, expect, it } from 'vitest';
import { Contracts } from '../../../src/core/contracts/index.js';
import { connectionsCheck } from '../../../src/skills/day/connections.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-25T12:00:00+09:00');

describe('what quietly stops the day features', () => {
  it('names a silent phone, a calendar without the list permission and a missing browser agent, with the fix', async () => {
    const { ctx } = createTestContext({
      now: NOW,
      capabilities: {
        [Contracts.phoneSignals.id]: { lastSeen: async () => new Date('2026-11-25T02:00:00+09:00'), latestLocation: async () => undefined, dayTotals: async () => ({}) },
        [Contracts.calendarRead.id]: { listEvents: async () => [], calendars: async () => ({ calendars: [], limited: true }) },
      },
    });
    const findings = await connectionsCheck(ctx).run(NOW);
    expect(findings.map((f) => [f.id, f.ok])).toEqual([['day.phone-signals', false], ['day.calendar-list', false], ['day.web-agent', false]]);
    expect(findings[0]?.line).toBe('휴대폰 신호가 10시간째 없어요.');
    expect(findings[1]?.fix).toContain('ax-kit connect google');
  });
});
