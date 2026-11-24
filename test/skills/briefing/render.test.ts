import { describe, expect, it } from 'vitest';
import type { CalendarEvent, MailSummary, WeatherReport } from '../../../src/core/contracts/index.js';
import type { BriefingData, BriefingTodo } from '../../../src/skills/briefing/gather.js';
import { briefingTexts } from '../../../src/skills/briefing/locale.js';
import { renderBriefing } from '../../../src/skills/briefing/render.js';

const TZ = 'Asia/Seoul';

const teamMeeting: CalendarEvent = {
  id: 'e1',
  title: '팀 회의',
  start: '2026-11-17T09:00:00+09:00',
  end: '2026-11-17T10:00:00+09:00',
  allDay: false,
};

const workshop: CalendarEvent = {
  id: 'e2',
  title: '워크숍',
  start: '2026-11-17',
  end: '2026-11-18',
  allDay: true,
};

const weeklyReport: MailSummary = {
  id: 'm1',
  threadId: 'th1',
  from: 'Mina',
  subject: '주간 보고',
  snippet: '이번 주 진행 상황입니다.',
  receivedAt: new Date('2026-11-17T07:30:00+09:00'),
  unread: true,
  important: true,
};

const overdueTodo: BriefingTodo = {
  id: 'd1',
  text: '보고서 작성',
  due: '2026-11-16',
  done: false,
  createdAt: '2026-11-01T09:00:00+09:00',
  overdue: true,
};

const todayTodo: BriefingTodo = {
  id: 'd2',
  text: '장보기',
  due: '2026-11-17T18:00:00+09:00',
  done: false,
  createdAt: '2026-11-01T09:00:00+09:00',
  overdue: false,
};

const WEATHER: WeatherReport = {
  sky: '맑음',
  tempC: 9,
  minC: 3,
  maxC: 12,
  rainChance: 10,
  air: { grade: '보통', pm10: 45, pm25: 20 },
  observedAt: new Date('2026-11-17T08:50:00+09:00'),
};

function briefing(overrides: Partial<BriefingData> = {}): BriefingData {
  return {
    date: { ymd: '2026-11-17', month: 11, day: 17, weekday: 'tue' },
    calendar: { state: 'ok', items: [] },
    mail: { state: 'ok', items: [] },
    todo: { state: 'ok', items: [] },
    ...overrides,
  };
}

function render(data: BriefingData, language = 'ko', ownerName?: string) {
  return renderBriefing(data, {
    texts: briefingTexts(language),
    timeZone: TZ,
    ...(ownerName !== undefined ? { ownerName } : {}),
  });
}

describe('renderBriefing', () => {
  it('renders the Korean briefing with a greeting, three sections and choices', () => {
    const message = render(
      briefing({
        calendar: { state: 'ok', items: [teamMeeting, workshop] },
        mail: { state: 'ok', items: [weeklyReport] },
        todo: { state: 'ok', items: [overdueTodo, todayTodo] },
      }),
      'ko',
      'Alex',
    );

    expect(message.text).toContain('좋은 아침이에요, Alex님. 11월 17일 (화) 브리핑이에요.');
    expect(message.text).toContain('일정\n- 09:00 팀 회의\n- 종일 워크숍');
    expect(message.text).toContain('중요 메일\n- Mina — 주간 보고');
    expect(message.text).toContain('할 일\n- 보고서 작성 (지남)\n- 장보기');
    expect(message.choices).toEqual([
      { id: '오늘 일정 자세히', label: '오늘 일정 자세히' },
      { id: '중요 메일 요약', label: '중요 메일 요약' },
      { id: '할 일 정리', label: '할 일 정리' },
    ]);
  });

  it('renders the local date and times in the owner zone', () => {
    const utcMorning: CalendarEvent = {
      id: 'e3',
      title: '통화',
      start: '2026-11-17T00:30:00Z',
      end: '2026-11-17T01:00:00Z',
      allDay: false,
    };
    const message = render(briefing({ calendar: { state: 'ok', items: [utcMorning] } }));
    expect(message.text).toContain('- 09:30 통화');
    expect(message.text).toContain('11월 17일 (화)');
  });

  it('shows an empty line for each section with nothing in it and offers no choices', () => {
    const message = render(briefing());
    expect(message.text).toContain('오늘 일정은 없어요.');
    expect(message.text).toContain('중요한 메일은 없어요.');
    expect(message.text).toContain('할 일은 없어요.');
    expect(message.choices).toBeUndefined();
  });

  it('distinguishes a missing connection from a failed source', () => {
    const message = render(
      briefing({
        calendar: { state: 'failed' },
        mail: { state: 'not_connected' },
        todo: { state: 'failed' },
      }),
    );
    expect(message.text).toContain('일정을 불러오지 못했어요.');
    expect(message.text).toContain('Gmail이 연결되지 않았어요 (ax-kit connect google)');
    expect(message.text).toContain('할 일을 불러오지 못했어요.');
    expect(message.text).not.toContain('- ');
    expect(message.choices).toBeUndefined();
  });

  it('offers choices only for sections that have content, in section order', () => {
    const message = render(
      briefing({
        mail: { state: 'ok', items: [weeklyReport] },
        todo: { state: 'ok', items: [todayTodo] },
      }),
    );
    expect(message.choices?.map((choice) => choice.id)).toEqual(['중요 메일 요약', '할 일 정리']);
  });

  it('renders the English briefing with English labels', () => {
    const teamMeetingEn: CalendarEvent = { ...teamMeeting, title: 'Team meeting' };
    const workshopEn: CalendarEvent = { ...workshop, title: 'Workshop' };
    const reportEn: MailSummary = { ...weeklyReport, from: 'Mina', subject: 'Weekly report' };
    const overdueEn: BriefingTodo = { ...overdueTodo, text: 'Write report' };

    const message = render(
      briefing({
        calendar: { state: 'ok', items: [teamMeetingEn, workshopEn] },
        mail: { state: 'ok', items: [reportEn] },
        todo: { state: 'ok', items: [overdueEn] },
      }),
      'en',
    );

    expect(message.text).toContain('Good morning. Here is your briefing for Tuesday, November 17.');
    expect(message.text).toContain('Schedule\n- 09:00 Team meeting\n- All day Workshop');
    expect(message.text).toContain('Important mail\n- Mina — Weekly report');
    expect(message.text).toContain('To-do\n- Write report (overdue)');
    expect(message.choices).toEqual([
      { id: "Today's schedule in detail", label: "Today's schedule in detail" },
      { id: 'Summarize important mail', label: 'Summarize important mail' },
      { id: 'Organize to-dos', label: 'Organize to-dos' },
    ]);
  });

  it('renders English empty and not-connected states', () => {
    const message = render(briefing({ mail: { state: 'not_connected' } }), 'en');
    expect(message.text).toContain('No events today.');
    expect(message.text).toContain('Gmail is not connected (ax-kit connect google)');
    expect(message.text).toContain('Nothing on your list.');
  });

  it('renders one weather line between the greeting and the sections', () => {
    const message = render(briefing({ weather: { state: 'ok', report: WEATHER } }));

    expect(message.text).toContain(
      '좋은 아침이에요. 11월 17일 (화) 브리핑이에요.\n\n날씨: 맑음 12°/3°, 미세먼지 보통\n\n일정',
    );
  });

  it('renders the English weather line with translated air grades', () => {
    const message = render(briefing({ weather: { state: 'ok', report: WEATHER } }), 'en');
    expect(message.text).toContain('Weather: 맑음 12°/3°, fine dust moderate');
  });

  it('omits the weather line when it is missing, unlocated or failed', () => {
    for (const state of ['not_connected', 'no_location', 'failed'] as const) {
      const message = render(briefing({ weather: { state } }));
      expect(message.text).not.toContain('날씨:');
    }
  });

  it('renders only the current temperature when the daily range is absent', () => {
    const report: WeatherReport = {
      sky: '흐림',
      tempC: 8,
      observedAt: WEATHER.observedAt,
    };
    const message = render(briefing({ weather: { state: 'ok', report } }));
    expect(message.text).toContain('날씨: 흐림 8°');
    expect(message.text).not.toContain('미세먼지');
  });
});
