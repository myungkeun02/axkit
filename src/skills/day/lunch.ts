import type { KnownPlaces, KnownPlacesSource, Place } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { ymdOf } from '../../core/time/local-day.js';
import { zonedIso } from '../../core/time/date-spec.js';
import { hourAndWeekday, near } from './places.js';

export const LUNCH_JOB = 'day.lunch';
const CHECK_SECONDS = 10 * 60;
/** The nudge goes out between these local minutes on a weekday (11:30–12:10). */
const FROM_MIN = 11 * 60 + 30;
const TO_MIN = 12 * 60 + 10;
const HOME_KM = 0.3;
const WORK_KM = 0.6;
const SUGGESTIONS = 4;

function minutesOf(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now);
  return Number(parts.find((part) => part.type === 'hour')?.value ?? '0') * 60 + Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
}

function placeLine(place: Place): string {
  const kind = place.category?.split('>').map((part) => part.trim()).filter((part) => part !== '').at(-1);
  const distance = place.distanceM !== undefined ? `${String(Math.round(place.distanceM))}m` : undefined;
  const extra = [kind, distance].filter((part): part is string => part !== undefined && part !== '').join(', ');
  return extra === '' ? `- ${place.name}` : `- ${place.name} (${extra})`;
}

/**
 * A weekday lunch nudge: no appointment over lunch, and the phone is at work (not at home), so "점심 드셔야죠!" with a
 * few places nearby. At home, or with a lunch already on the calendar, it says nothing. Once a day.
 */
export async function lunchNudge(ctx: PluginContext, now: Date, places: KnownPlacesSource): Promise<'sent' | 'skipped'> {
  const zone = ctx.assistant.timezone;
  const { weekday } = hourAndWeekday(now, zone);
  const minutes = minutesOf(now, zone);
  if (weekday < 1 || weekday > 5 || minutes < FROM_MIN || minutes > TO_MIN) return 'skipped';
  const ymd = ymdOf(now, zone);
  const key = `lunch:${ymd}`;
  if ((await ctx.kv.get<boolean>(key)) === true) return 'skipped';
  const notifier = ctx.tryUse(Contracts.notifier);
  const phone = ctx.tryUse(Contracts.phoneSignals);
  if (notifier === undefined || phone === undefined) return 'skipped';
  const here = await phone.latestLocation(45).catch(() => undefined);
  if (here === undefined) return 'skipped';
  const known: KnownPlaces = await places.get().catch(() => ({}));
  const { home, work } = known;
  // at home: nothing to say; work known but elsewhere (out on a visit): nothing either
  if (near(here, home, HOME_KM)) return 'skipped';
  if (work !== undefined && !near(here, work, WORK_KM)) return 'skipped';
  const calendar = ctx.tryUse(Contracts.calendarRead);
  if (calendar !== undefined) {
    const from = new Date(zonedIso(ymd, '11:30', zone));
    const to = new Date(zonedIso(ymd, '13:30', zone));
    const events = await calendar.listEvents({ from, to }).catch(() => []);
    const busy = events.some((event) => !event.allDay && Date.parse(event.start) < to.getTime() && Date.parse(event.end) > from.getTime());
    if (busy) {
      await ctx.kv.set(key, true);
      return 'skipped';
    }
  }
  const korean = ctx.assistant.language !== 'en';
  const found = await ctx.tryUse(Contracts.places)?.search(korean ? '음식점' : 'restaurant', { near: here, limit: SUGGESTIONS }).catch(() => []);
  const lines = [korean ? '점심 드셔야죠! 점심시간에 약속이 없어요.' : 'Time for lunch! Nothing on your calendar over lunch.'];
  if (found !== undefined && found.length > 0) lines.push(korean ? '근처 식당:' : 'Nearby:', ...found.slice(0, SUGGESTIONS).map(placeLine));
  await notifier.notify({ kind: 'day.lunch', dedupeKey: key, text: lines.join('\n') });
  await ctx.kv.set(key, true);
  return 'sent';
}

export function registerLunch(ctx: PluginContext, places: KnownPlacesSource): void {
  ctx.scheduler.add({ name: LUNCH_JOB, schedule: { kind: 'every', seconds: CHECK_SECONDS }, run: async (now) => void (await lunchNudge(ctx, now, places)) });
}
