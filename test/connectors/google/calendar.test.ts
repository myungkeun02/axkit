import { describe, expect, it } from 'vitest';
import { GoogleCalendar } from '../../../src/connectors/google/calendar.js';
import { fakeFetch, json, requestWithToken } from './helpers.js';

const RANGE = {
  from: new Date('2026-11-17T00:00:00Z'),
  to: new Date('2026-11-18T00:00:00Z'),
};

describe('GoogleCalendar.listEvents', () => {
  it('queries the primary calendar and maps events', async () => {
    const fake = fakeFetch(() =>
      json({
        items: [
          {
            id: 'e1',
            status: 'confirmed',
            summary: 'Standup',
            start: { dateTime: '2026-11-17T10:00:00+09:00' },
            end: { dateTime: '2026-11-17T10:15:00+09:00' },
            location: 'Room 1',
            attendees: [{ email: 'alex@example.com' }, { email: 'mina@example.com' }],
            htmlLink: 'https://calendar.example.com/e1',
          },
          {
            id: 'e2',
            status: 'confirmed',
            summary: 'Holiday',
            start: { date: '2026-11-18' },
            end: { date: '2026-11-19' },
          },
          {
            id: 'e3',
            status: 'cancelled',
            summary: 'Cancelled',
            start: { dateTime: '2026-11-17T12:00:00+09:00' },
            end: { dateTime: '2026-11-17T13:00:00+09:00' },
          },
        ],
      }),
    );
    const calendar = new GoogleCalendar({ request: requestWithToken(fake, 'calendar-token'), timeZone: 'Asia/Seoul' });

    const events = await calendar.listEvents(RANGE);

    const call = fake.calls[0];
    expect(call?.url.pathname).toBe('/calendar/v3/calendars/primary/events');
    expect(call?.url.searchParams.get('timeMin')).toBe('2026-11-17T00:00:00.000Z');
    expect(call?.url.searchParams.get('timeMax')).toBe('2026-11-18T00:00:00.000Z');
    expect(call?.url.searchParams.get('singleEvents')).toBe('true');
    expect(call?.url.searchParams.get('orderBy')).toBe('startTime');
    expect(call?.url.searchParams.get('maxResults')).toBe('50');
    expect(call?.headers.get('authorization')).toBe('Bearer calendar-token');

    expect(events).toEqual([
      {
        id: 'e1',
        title: 'Standup',
        start: '2026-11-17T10:00:00+09:00',
        end: '2026-11-17T10:15:00+09:00',
        allDay: false,
        location: 'Room 1',
        attendees: ['alex@example.com', 'mina@example.com'],
        url: 'https://calendar.example.com/e1',
      },
      {
        id: 'e2',
        title: 'Holiday',
        start: '2026-11-18',
        end: '2026-11-19',
        allDay: true,
      },
    ]);
  });
});

describe('GoogleCalendar.createEvent', () => {
  it('invites attendees and asks Google to send updates', async () => {
    const fake = fakeFetch(() =>
      json({
        id: 'new-1',
        summary: 'Lunch',
        start: { dateTime: '2026-11-20T12:00:00+09:00' },
        end: { dateTime: '2026-11-20T13:00:00+09:00' },
        htmlLink: 'https://calendar.example.com/new-1',
      }),
    );
    const calendar = new GoogleCalendar({ request: requestWithToken(fake), timeZone: 'Asia/Seoul' });

    const created = await calendar.createEvent({
      title: 'Lunch',
      start: '2026-11-20T12:00:00+09:00',
      end: '2026-11-20T13:00:00+09:00',
      allDay: false,
      location: 'Cafe',
      description: 'Bring notes',
      attendees: ['alex@example.com'],
    });

    const call = fake.calls[0];
    expect(call?.method).toBe('POST');
    expect(call?.url.searchParams.get('sendUpdates')).toBe('all');
    expect(call?.headers.get('content-type')).toBe('application/json');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      summary: 'Lunch',
      start: { dateTime: '2026-11-20T12:00:00+09:00', timeZone: 'Asia/Seoul' },
      end: { dateTime: '2026-11-20T13:00:00+09:00', timeZone: 'Asia/Seoul' },
      location: 'Cafe',
      description: 'Bring notes',
      attendees: [{ email: 'alex@example.com' }],
    });
    expect(created).toMatchObject({ id: 'new-1', title: 'Lunch', url: 'https://calendar.example.com/new-1' });
  });

  it('creates an all-day event without notifications when nobody is invited', async () => {
    const fake = fakeFetch(() =>
      json({
        id: 'new-2',
        summary: 'Focus day',
        start: { date: '2026-11-21' },
        end: { date: '2026-11-22' },
      }),
    );
    const calendar = new GoogleCalendar({ request: requestWithToken(fake), timeZone: 'Asia/Seoul' });

    await calendar.createEvent({
      title: 'Focus day',
      start: '2026-11-21T00:00:00+09:00',
      end: '2026-11-22T00:00:00+09:00',
      allDay: true,
    });

    const call = fake.calls[0];
    expect(call?.url.searchParams.get('sendUpdates')).toBe('none');
    expect(JSON.parse(call?.body ?? '{}')).toEqual({
      summary: 'Focus day',
      start: { date: '2026-11-21' },
      end: { date: '2026-11-22' },
    });
  });
});
