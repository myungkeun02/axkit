import { describe, expect, it } from 'vitest';
import { GoogleCalendar } from '../../../src/connectors/google/calendar.js';
import { fakeFetch, json, requestWithToken } from './helpers.js';

const RANGE = {
  from: new Date('2026-11-17T00:00:00Z'),
  to: new Date('2026-11-18T00:00:00Z'),
};

describe('GoogleCalendar.listEvents', () => {
  it('queries the main calendar and maps events', async () => {
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

    const call = fake.calls.find((item) => item.url.pathname.endsWith('/events'));
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

describe('GoogleCalendar over every shown calendar', () => {
  const CALENDARS = {
    items: [
      { id: 'me@example.com', summary: 'me@example.com', primary: true, accessRole: 'owner', selected: true },
      { id: 'biz123@group.calendar.google.com', summary: 'biz', accessRole: 'writer', selected: true, description: '회사 일정' },
      { id: 'hidden@group.calendar.google.com', summary: 'old', accessRole: 'owner', selected: true, hidden: true },
      { id: 'off@group.calendar.google.com', summary: 'off', accessRole: 'owner', selected: false },
      { id: 'ko.south_korea#holiday@group.v.calendar.google.com', summary: '대한민국의 휴일', accessRole: 'reader', selected: true },
    ],
  };
  const event = (id: string, summary: string, start: string, uid?: string) => ({ id, summary, status: 'confirmed', start: { dateTime: start }, end: { dateTime: start }, ...(uid !== undefined ? { iCalUID: uid } : {}) });

  function setup(listStatus = 200) {
    const fake = fakeFetch((call) => {
      if (call.url.pathname.endsWith('/calendarList')) return listStatus === 200 ? json(CALENDARS) : json({ error: { code: listStatus } }, listStatus);
      if (call.method === 'POST') return json(event('new', 'x', '2026-11-25T10:00:00+09:00'));
      const id = decodeURIComponent(call.url.pathname.split('/')[4] ?? '');
      if (id === 'primary') return json({ items: [event('p1', '점심', '2026-11-17T12:00:00+09:00', 'uid-shared'), event('p2', '운동', '2026-11-17T20:00:00+09:00')] });
      if (id === 'biz123@group.calendar.google.com') return json({ items: [event('b1', '주간 회의', '2026-11-17T09:00:00+09:00'), event('b2', '점심', '2026-11-17T12:00:00+09:00', 'uid-shared')] });
      if (id.includes('holiday')) return json({ items: [] });
      throw new Error(`unexpected ${id}`);
    });
    return { fake, calendar: new GoogleCalendar({ request: requestWithToken(fake), timeZone: 'Asia/Seoul' }) };
  }

  it('reads every calendar the owner checked, names each event and shows a shared meeting once', async () => {
    const { fake, calendar } = setup();
    const events = await calendar.listEvents(RANGE);
    expect(events.map((item) => [item.title, item.calendar])).toEqual([
      ['주간 회의', 'biz'],
      ['점심', 'me@example.com'],
      ['운동', 'me@example.com'],
    ]);
    const asked = fake.calls.filter((call) => call.url.pathname.endsWith('/events')).map((call) => decodeURIComponent(call.url.pathname.split('/')[4] ?? ''));
    expect(asked).not.toContain('hidden@group.calendar.google.com');
    expect(asked).not.toContain('off@group.calendar.google.com');
    const list = await calendar.calendars();
    expect(list.calendars.map((item) => [item.name, item.writable])).toEqual([['me@example.com', true], ['biz', true], ['대한민국의 휴일', false]]);
  });

  it('adds to the calendar the draft names, by name, and refuses one it cannot write', async () => {
    const { fake, calendar } = setup();
    const created = await calendar.createEvent({ title: '고객 미팅', start: '2026-11-25T10:00:00+09:00', end: '2026-11-25T11:00:00+09:00', allDay: false, calendar: 'BIZ' });
    expect(created.calendar).toBe('biz');
    expect(fake.calls.find((call) => call.method === 'POST')?.url.pathname).toBe(`/calendar/v3/calendars/${encodeURIComponent('biz123@group.calendar.google.com')}/events`);
    await expect(calendar.createEvent({ title: 'x', start: '2026-11-25', end: '2026-11-26', allDay: true, calendar: '대한민국의 휴일' })).rejects.toThrow('넣을 수 있는 캘린더: me@example.com, biz');
  });

  it('falls back to the main calendar when the sign-in cannot list calendars, and says so', async () => {
    const { calendar } = setup(403);
    expect((await calendar.listEvents(RANGE)).map((item) => item.title)).toEqual(['점심', '운동']);
    expect(await calendar.calendars()).toMatchObject({ limited: true, calendars: [{ id: 'primary' }] });
  });
});
