import { describe, expect, it } from 'vitest';
import type { CalendarEvent } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { transitSweep } from '../../../src/skills/day/transit-job.js';
import { formatCard, parseRoutes, recommendDeparture } from '../../../src/skills/day/transit-route.js';
import { createTestContext } from '../../support/context.js';

const TZ = 'Asia/Seoul';
const ANSWER = JSON.stringify({
  routes: [
    { m: 35, tr: 1, w: 8, fare: 1450, legs: [{ md: 'walk', rd: 5 }, { md: 'subway', ln: '2호선', fr: '선릉역', to: '강남역', st: 2, rd: 4, hw: '3-5', nx: ['13:14', '13:20'] }, { md: 'bus', ln: '146', fr: '강남역', to: '역삼동', rd: 10 }] },
    { m: 50, tr: 2, w: 3, legs: [{ md: 'bus', ln: '360', rd: 40 }] },
  ],
});
const MEETING: CalendarEvent = { id: 'e1', title: '고객 미팅', start: '2026-11-26T14:00:00+09:00', end: '2026-11-26T15:00:00+09:00', allDay: false, location: '강남역 3번 출구' };

describe('route parsing and cards', () => {
  it('reads the routes, snaps the departure to a real train and writes the card', () => {
    const routes = parseRoutes(`결과입니다: ${ANSWER}`);
    expect(routes.map((r) => r.totalMin)).toEqual([35, 50]);
    expect(routes[0]?.legs[1]).toMatchObject({ line: '2호선', headwayMin: 5, next: ['13:14', '13:20'] });
    const start = new Date(MEETING.start);
    const departure = recommendDeparture(start, routes[0]!, 10, TZ);
    // latest 13:15, +5 min walk = board by 13:20 → the 13:20 train, leave 13:15
    expect(departure).toMatchObject({ rounded: true });
    expect(departure.departAt.toISOString()).toBe('2026-11-26T04:15:00.000Z');
    const card = formatCard({ title: MEETING.title, startAt: start, routes, departure, originNote: '출발: 집(선릉역)', timeZone: TZ });
    expect(card).toContain('고객 미팅 → 추천 경로 (35분, 환승 1, 도보 8분, 1,450원)');
    expect(card).toContain('13:15 출발 권장');
    expect(card).toContain('① 2호선 (선릉역 → 강남역) 배차 5분 · 다음 13:14, 13:20');
    expect(card).toContain('② 146번 버스 (강남역 → 역삼동)');
    expect(card).toContain('다른 경로: 50분, 환승 2');
  });

  it('drops an answer that is not the asked shape', () => {
    expect(parseRoutes('찾지 못했어요')).toEqual([]);
    expect(parseRoutes('{"routes":[{"m":"많이"}]}')).toEqual([]);
  });
});

describe('transit sweep', () => {
  function setup(now: Date, events: CalendarEvent[]) {
    const notices: { text: string; urgent?: boolean }[] = [];
    const tasks: string[] = [];
    const context = createTestContext({
      now,
      capabilities: {
        [Contracts.calendarRead.id]: { listEvents: async () => events },
        [Contracts.notifier.id]: { notify: async (notice: { text: string }) => void notices.push(notice) },
        [Contracts.webAgent.id]: { label: 'fake', run: async (input: { task: string }) => (tasks.push(input.task), { ok: true, answer: ANSWER }) },
        [Contracts.memoryRead.id]: { recall: async () => [{ id: 'f1', subject: 'owner', text: '집은 선릉역이야', source: { kind: 'chat' }, at: '', strength: 1 }] },
      },
    });
    return { ...context, notices, tasks };
  }

  it('posts one card, then the live departures ten minutes before leaving', async () => {
    const morning = new Date('2026-11-26T09:00:00+09:00');
    const context = setup(morning, [MEETING, { ...MEETING, id: 'online', location: 'https://meet.google.com/abc-defg-hij' }]);
    await transitSweep(context.ctx, morning);
    await transitSweep(context.ctx, morning);
    expect(context.tasks).toHaveLength(1);
    expect(context.tasks[0]).toContain('출발 "선릉역" 도착 "강남역 3번 출구"');
    expect(context.notices[0]?.text).toContain('출발: 집(선릉역)');

    const soon = new Date('2026-11-26T13:06:00+09:00');
    await transitSweep(context.ctx, soon);
    expect(context.tasks).toHaveLength(2);
    expect(context.notices[1]).toMatchObject({ urgent: true });
    expect(context.notices[1]?.text).toContain('🚶 지금 나가시면 돼요 — 14:00 고객 미팅');
    expect(context.notices[1]?.text).toContain('2호선 선릉역: 다음 13:14, 13:20');
  });

  it('asks once for the home base when it has nowhere to start from', async () => {
    const morning = new Date('2026-11-26T09:00:00+09:00');
    const context = setup(morning, [MEETING]);
    context.provided.set(Contracts.memoryRead.id, { recall: async () => [] });
    await transitSweep(context.ctx, morning);
    await transitSweep(context.ctx, morning);
    expect(context.tasks).toHaveLength(0);
    expect(context.notices.map((n) => n.text)).toEqual(['🚇 길 안내 출발지로 쓸 집 근처 역이나 동을 알려 주세요 (예: "집은 정자역이야, 기억해")']);
  });
});
