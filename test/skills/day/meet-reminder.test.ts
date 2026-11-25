import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { sendMeetLinks } from '../../../src/skills/day/meet-reminder.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-25T14:50:00+09:00');

function setup(events: CalendarEvent[]) {
  const notices: { text: string }[] = [];
  const context = createTestContext({
    now: NOW,
    capabilities: {
      [Contracts.calendarRead.id]: { listEvents: async () => events },
      [Contracts.notifier.id]: { notify: async (notice: { text: string }) => void notices.push(notice) },
    },
  });
  return { ...context, notices };
}

describe('meeting links ten minutes before', () => {
  it('sends the join link once for a meeting starting in ten minutes', async () => {
    const meeting: CalendarEvent = { id: 'e1', title: '주간 회의', start: '2026-11-25T15:00:00+09:00', end: '2026-11-25T16:00:00+09:00', allDay: false, meetLink: 'https://meet.google.com/abc-defg-hij' };
    const later: CalendarEvent = { ...meeting, id: 'e2', start: '2026-11-25T15:30:00+09:00' };
    const plain: CalendarEvent = { ...meeting, id: 'e3' };
    delete (plain as { meetLink?: string }).meetLink;
    const context = setup([meeting, later, plain]);
    expect(await sendMeetLinks(context.ctx, NOW, true)).toBe(1);
    expect(context.notices[0]?.text).toBe("10분 뒤 15:00 '주간 회의' 회의예요.\n참여: https://meet.google.com/abc-defg-hij");
    expect(await sendMeetLinks(context.ctx, NOW, true)).toBe(0);
  });

  it('finds a link written in the place', async () => {
    const context = setup([{ id: 'e1', title: '고객 미팅', start: '2026-11-25T15:00:00+09:00', end: '2026-11-25T16:00:00+09:00', allDay: false, location: 'https://zoom.us/j/123456789' }]);
    expect(await sendMeetLinks(context.ctx, NOW, true)).toBe(1);
  });
});
