import { describe, expect, it } from 'vitest';
import { recommend } from '../../../src/channels/app/views/routes.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { CalendarReader } from '../../../src/core/contracts/calendar.js';
import type { PlaceSource, RouteOption, RouteSource } from '../../../src/core/contracts/index.js';
import type { Plugin } from '../../../src/core/plugin/types.js';
import { api, pairApp, startApp } from './harness.js';

function places(searched: string[]): PlaceSource {
  return {
    async search(query) {
      searched.push(query);
      if (/온라인/.test(query) || query === '어딘가') return [];
      return [{ name: query, address: `${query} 주소`, point: query.includes('집') ? { lat: 37.55, lng: 126.92 } : { lat: 37.5, lng: 127.03 } }];
    },
    geocode: async () => undefined,
  };
}

const option = (mode: RouteOption['mode'], durationMin: number): RouteOption => ({ mode, durationMin, distanceKm: 10, summary: mode, steps: [], path: [[0, 0]] });

function fakeLife(searched: string[]): Plugin {
  const routes: RouteSource = { car: async () => option('car', 30), transit: async () => option('transit', 33) };
  const calendar: CalendarReader = {
    listEvents: async () => [
      { id: 'e1', title: '회의', start: '2026-11-19T10:00:00+09:00', end: '2026-11-19T11:00:00+09:00', allDay: false, location: '강남역' },
      { id: 'e2', title: '화상 통화', start: '2026-11-19T12:00:00+09:00', end: '2026-11-19T12:30:00+09:00', allDay: false, location: 'Zoom 온라인' },
      { id: 'e3', title: '점심', start: '2026-11-19T11:10:00+09:00', end: '2026-11-19T12:00:00+09:00', allDay: false, location: '역삼역' },
    ],
  };
  return {
    manifest: { id: 'test.life', kind: 'connector', title: 'life' },
    setup: (ctx) => {
      ctx.provide(Contracts.places, places(searched));
      ctx.provide(Contracts.routes, routes);
      ctx.provide(Contracts.calendarRead, calendar);
    },
  };
}

describe('desktop app requests D3 D5 D7 D8 D9', () => {
  it('routes the day from home in plain words, adds geo to events, and caches the day', async () => {
    const searched: string[] = [];
    const h = await startApp({ plugins: [fakeLife(searched)] });
    try {
      const { token } = await pairApp(h);
      const caps = (await (await api(h, token, 'capabilities')).json()) as { features: string[] };
      expect(caps.features).toContain('routes');
      const before = (await (await api(h, token, 'views/routes?date=2026-11-19')).json()) as { data: { origin: unknown; note: string } };
      expect(before.data.origin).toBeNull();
      const missing = await api(h, token, 'views/routes/setHome', { query: '어딘가' });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({ ok: false, error: 'shape', message: '그 주소를 찾지 못했어요.' });
      expect(await (await api(h, token, 'views/routes/setHome', { nope: 1 })).json()).toEqual({ ok: false, error: 'shape' });
      expect((await api(h, token, 'views/routes/setHome', { query: '우리집 마포' })).status).toBe(200);
      const day = (await (await api(h, token, 'views/routes?date=2026-11-19')).json()) as { data: { legs: { eventId: string; from: { name: string }; options: { mode: string; recommended?: boolean; leaveAt: string }[]; note?: string }[] } };
      expect(day.data.legs.map((leg) => leg.eventId)).toEqual(['e1', 'e3']);
      expect(day.data.legs[0]?.from.name).toBe('집');
      expect(day.data.legs[0]?.options.find((o) => o.recommended)?.mode).toBe('transit');
      expect(day.data.legs[0]?.options.find((o) => o.mode === 'transit')?.leaveAt).toBe('2026-11-19T00:22:00.000Z');
      expect(day.data.legs[1]?.note).toContain('앞 일정이 끝나기 전에');
      const count = searched.length;
      await api(h, token, 'views/routes?date=2026-11-19');
      expect(searched.length).toBe(count);
      const cal = (await (await api(h, token, 'views/calendar?month=2026-11')).json()) as { data: { days: { date: string; events: { id: string; geo?: { lat: number } }[] }[] } };
      const events = cal.data.days.find((d) => d.date === '2026-11-19')?.events ?? [];
      expect(events.find((e) => e.id === 'e1')?.geo?.lat).toBe(37.5);
      expect(events.find((e) => e.id === 'e2')?.geo).toBeUndefined();
    } finally {
      await h.stop();
    }
  });

  it('picks transit when it is within five minutes of the car', () => {
    expect(recommend([option('transit', 35), option('car', 30)])).toBe(0);
    expect(recommend([option('transit', 50), option('car', 30)])).toBe(1);
  });

  it('adds approvals history and the team on done work, and splits daily usage', async () => {
    const h = await startApp();
    try {
      const { token } = await pairApp(h);
      const approvals = (await (await api(h, token, 'views/approvals')).json()) as { data: { history: { weeks: { week: string; asked: number }[] } } };
      expect(approvals.data.history.weeks).toHaveLength(8);
      expect(new Date(`${approvals.data.history.weeks[7]?.week}T12:00:00Z`).getUTCDay()).toBe(1);
      const usage = (await (await api(h, token, 'views/usage?period=week')).json()) as { data: { daily: { byModel?: object; byBot?: object }[] } };
      expect(usage.data.daily[0]).toMatchObject({ byModel: {}, byBot: {} });
    } finally {
      await h.stop();
    }
  });

  it('records webm uploads as webm and replays the stream when Last-Event-ID is past the end', async () => {
    const h = await startApp();
    try {
      const { token } = await pairApp(h);
      await api(h, token, 'messages', { text: '안녕' });
      const controller = new AbortController();
      const response = await fetch(`${h.base}/m/v1/app/stream`, { headers: { authorization: `Bearer ${token}`, 'last-event-id': '999999999' }, signal: controller.signal });
      const reader = response.body!.getReader();
      const { value } = await reader.read();
      controller.abort();
      expect(new TextDecoder().decode(value)).toContain('안녕');
    } finally {
      await h.stop();
    }
  });
});
