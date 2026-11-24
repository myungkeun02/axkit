import { describe, expect, it } from 'vitest';
import type {
  CalendarEvent,
  CalendarReader,
  GeoPoint,
  MailMessage,
  MailQuery,
  MailReader,
  Notice,
  NoticeResult,
  Notifier,
  PhoneDayTotals,
  PhoneLocation,
  PhoneSignals,
  WeatherReport,
  WeatherSource,
} from '../../../src/core/contracts/index.js';
import { Contracts, MissingKeyError } from '../../../src/core/contracts/index.js';
import type { Logger } from '../../../src/core/log/types.js';
import { briefingSkill } from '../../../src/skills/briefing/plugin.js';
import type { TestContextOptions } from '../../support/context.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-17T08:00:00+09:00');

const meeting: CalendarEvent = {
  id: 'e1',
  title: '팀 회의',
  start: '2026-11-17T09:00:00+09:00',
  end: '2026-11-17T10:00:00+09:00',
  allDay: false,
};

function recorder(warnings: string[]): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => {
      warnings.push(msg);
    },
    error: () => {},
    child: () => logger,
  };
  return logger;
}

class FakeNotifier implements Notifier {
  readonly notices: Notice[] = [];
  constructor(private readonly result: NoticeResult = 'sent') {}
  async notify(notice: Notice): Promise<NoticeResult> {
    this.notices.push(notice);
    return this.result;
  }
}

class FakeCalendarReader implements CalendarReader {
  constructor(private readonly events: CalendarEvent[] = []) {}
  async listEvents(): Promise<CalendarEvent[]> {
    return this.events;
  }
}

class FakeMailReader implements MailReader {
  readonly queries: MailQuery[] = [];
  async search(query: MailQuery): Promise<never[]> {
    this.queries.push(query);
    return [];
  }
  async read(): Promise<MailMessage> {
    throw new Error('not implemented in the fake');
  }
}

const REPORT: WeatherReport = {
  sky: '맑음',
  tempC: 9,
  minC: 3,
  maxC: 12,
  air: { grade: '보통', pm10: 45 },
  observedAt: new Date('2026-11-17T07:50:00+09:00'),
};

class FakeWeather implements WeatherSource {
  readonly points: GeoPoint[] = [];
  constructor(private readonly report: WeatherReport | Error = REPORT) {}
  async today(point: GeoPoint): Promise<WeatherReport> {
    this.points.push(point);
    if (this.report instanceof Error) throw this.report;
    return this.report;
  }
}

class FakePhone implements PhoneSignals {
  constructor(private readonly location: PhoneLocation | undefined) {}
  async latestLocation(): Promise<PhoneLocation | undefined> {
    return this.location;
  }
  async dayTotals(): Promise<PhoneDayTotals> {
    return {};
  }
  async lastSeen(): Promise<Date | undefined> {
    return undefined;
  }
}

async function setup(options: TestContextOptions = {}) {
  const context = createTestContext({ now: NOW, ...options });
  await briefingSkill().setup(context.ctx);
  return context;
}

describe('briefingSkill', () => {
  it('registers a daily job at 08:00 and sends the briefing with the local date as dedupe key', async () => {
    const notifier = new FakeNotifier();
    const { scheduler } = await setup({
      capabilities: {
        [Contracts.notifier.id]: notifier,
        [Contracts.calendarRead.id]: new FakeCalendarReader([meeting]),
      },
    });

    expect(scheduler.jobs.get('briefing.morning')?.schedule).toEqual({ kind: 'daily', at: '08:00' });
    await scheduler.run('briefing.morning', NOW);

    expect(notifier.notices).toHaveLength(1);
    const notice = notifier.notices[0];
    expect(notice?.kind).toBe('briefing.morning');
    expect(notice?.dedupeKey).toBe('2026-11-17');
    expect(notice?.text).toContain('좋은 아침이에요.');
    expect(notice?.text).toContain('09:00 팀 회의');
  });

  it('reads the time and mail limit from the plugin config', async () => {
    const notifier = new FakeNotifier();
    const mail = new FakeMailReader();
    const { scheduler } = await setup({
      config: { at: '07:30', mailLimit: 2 },
      capabilities: { [Contracts.notifier.id]: notifier, [Contracts.mailRead.id]: mail },
    });

    expect(scheduler.jobs.get('briefing.morning')?.schedule).toEqual({ kind: 'daily', at: '07:30' });
    await scheduler.run('briefing.morning', NOW);
    expect(mail.queries[0]?.limit).toBe(2);
    expect(notifier.notices).toHaveLength(1);
  });

  it('keys the notice by the local day just after midnight', async () => {
    const notifier = new FakeNotifier();
    const { scheduler } = await setup({ capabilities: { [Contracts.notifier.id]: notifier } });

    await scheduler.run('briefing.morning', new Date('2026-11-18T00:05:00+09:00'));
    expect(notifier.notices[0]?.dedupeKey).toBe('2026-11-18');
  });

  it('warns instead of failing when no notifier is available', async () => {
    const warnings: string[] = [];
    const { ctx, scheduler } = await setup();
    ctx.log = recorder(warnings);

    await expect(scheduler.run('briefing.morning', NOW)).resolves.toBeUndefined();
    expect(warnings).toEqual(['briefing: no notifier available; briefing skipped']);
  });

  it('sends the first briefing once on app.started and records the time', async () => {
    const notifier = new FakeNotifier();
    const { ctx, bus, kv } = await setup({ capabilities: { [Contracts.notifier.id]: notifier } });

    await bus.emit('app.started', { at: ctx.clock.now() });
    await bus.emit('app.started', { at: ctx.clock.now() });

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.dedupeKey).toBe('2026-11-17');
    expect(await kv.get('firstSentAt')).toBe(ctx.clock.now().toISOString());
  });

  it('does not send a second first briefing when firstSentAt is already stored', async () => {
    const notifier = new FakeNotifier();
    const { ctx, bus, kv } = await setup({ capabilities: { [Contracts.notifier.id]: notifier } });
    await kv.set('firstSentAt', '2026-11-16T00:00:00.000Z');

    await bus.emit('app.started', { at: ctx.clock.now() });
    expect(notifier.notices).toHaveLength(0);
  });

  it('leaves firstSentAt unset when the first briefing had no notifier', async () => {
    const warnings: string[] = [];
    const { ctx, bus, kv } = await setup();
    ctx.log = recorder(warnings);

    await bus.emit('app.started', { at: ctx.clock.now() });
    expect(warnings).toContain('briefing: no notifier available; briefing skipped');
    expect(await kv.get('firstSentAt')).toBeUndefined();
  });

  it('exposes briefing.now as a read tool that returns the text', async () => {
    const { ctx, registry } = await setup({
      capabilities: {
        [Contracts.calendarRead.id]: new FakeCalendarReader([meeting]),
        [Contracts.mailRead.id]: new FakeMailReader(),
      },
    });

    expect(registry.get('briefing.now')?.effects).toEqual(['read']);
    const outcome = await ctx.tools.execute('briefing.now', {});
    if (outcome.status !== 'done') throw new Error(`unexpected status: ${outcome.status}`);
    expect(outcome.output).toContain('좋은 아침이에요.');
    expect(outcome.output).toContain('09:00 팀 회의');
  });

  it('adds one weather line using the phone location', async () => {
    const notifier = new FakeNotifier();
    const weather = new FakeWeather();
    const phone = new FakePhone({ lat: 37.5, lng: 127, label: '지금', at: NOW });
    const { scheduler } = await setup({
      capabilities: {
        [Contracts.notifier.id]: notifier,
        [Contracts.weather.id]: weather,
        [Contracts.phoneSignals.id]: phone,
      },
    });

    await scheduler.run('briefing.morning', NOW);

    expect(weather.points).toEqual([{ lat: 37.5, lng: 127 }]);
    expect(notifier.notices[0]?.text).toContain('날씨: 맑음 12°/3°, 미세먼지 보통');
  });

  it('falls back to the configured weatherHome when the phone has no location', async () => {
    const notifier = new FakeNotifier();
    const weather = new FakeWeather();
    const { scheduler } = await setup({
      config: { weatherHome: { lat: 37.51, lng: 127.02, label: '집' } },
      capabilities: { [Contracts.notifier.id]: notifier, [Contracts.weather.id]: weather },
    });

    await scheduler.run('briefing.morning', NOW);

    expect(weather.points).toEqual([{ lat: 37.51, lng: 127.02 }]);
    expect(notifier.notices[0]?.text).toContain('날씨: 맑음');
  });

  it('omits the weather line when the weather source needs a missing key', async () => {
    const notifier = new FakeNotifier();
    const weather = new FakeWeather(new MissingKeyError('ko.data-go-kr.key', '키를 넣어 주세요'));
    const { scheduler } = await setup({
      config: { weatherHome: { lat: 37.51, lng: 127.02 } },
      capabilities: { [Contracts.notifier.id]: notifier, [Contracts.weather.id]: weather },
    });

    await scheduler.run('briefing.morning', NOW);

    expect(notifier.notices).toHaveLength(1);
    expect(notifier.notices[0]?.text).toContain('좋은 아침이에요.');
    expect(notifier.notices[0]?.text).not.toContain('날씨:');
  });

  it('omits the weather line when no weather connector is enabled', async () => {
    const notifier = new FakeNotifier();
    const { scheduler } = await setup({
      config: { weatherHome: { lat: 37.51, lng: 127.02 } },
      capabilities: { [Contracts.notifier.id]: notifier },
    });

    await scheduler.run('briefing.morning', NOW);
    expect(notifier.notices[0]?.text).not.toContain('날씨:');
  });
});
