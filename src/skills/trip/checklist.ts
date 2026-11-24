import type { GeoPoint } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { daysFromTo, ymdOf } from '../../core/time/local-day.js';
import type { TripDeps } from './deps.js';
import { checklistNotice, tripName } from './format.js';
import { groupTrips } from './group.js';
import type { Trip } from './types.js';

export const CHECKLIST_JOB = 'trip.checklist';
const WEATHER_DAY = 1;

export interface ChecklistDeps extends TripDeps {
  remindDays: readonly number[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PRINTED_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** The stay's printed check-in date is local to the destination; otherwise the trip's first day. */
export function destinationYmd(trip: Trip): string {
  const stay = trip.segments.find((segment) => segment.kind === 'stay');
  const match = stay === undefined ? null : PRINTED_DATE.exec(stay.startText);
  return match === null ? trip.startYmd : `${match[1]}-${match[2]}-${match[3]}`;
}

async function weatherLine(ctx: PluginContext, deps: ChecklistDeps, trip: Trip): Promise<string | undefined> {
  const places = ctx.tryUse(Contracts.places);
  const weather = ctx.tryUse(Contracts.weather);
  if (places === undefined || weather === undefined) return undefined;

  const destination = tripName(trip, deps.texts);
  let point: GeoPoint | undefined;
  try {
    point = await places.geocode(destination);
  } catch (error) {
    ctx.log.warn('trip checklist: destination could not be geocoded', { error: messageOf(error) });
    return undefined;
  }
  if (point === undefined) return undefined;

  // D-1 talks about the day of departure at the destination, never today's weather where the owner is.
  if (weather.forecast === undefined) return undefined;
  try {
    const report = await weather.forecast(point, destinationYmd(trip));
    return report === undefined ? undefined : deps.texts.weatherLine(destination, report);
  } catch (error) {
    ctx.log.warn('trip checklist: weather could not be loaded', { error: messageOf(error) });
    return undefined;
  }
}

async function sendChecklists(ctx: PluginContext, deps: ChecklistDeps, now: Date): Promise<void> {
  const trips = groupTrips(deps.store.all(), deps.timeZone);
  if (trips.length === 0) return;

  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    ctx.log.warn('trip checklist: no notifier available');
    return;
  }

  const today = ymdOf(now, deps.timeZone);
  for (const trip of trips) {
    const days = daysFromTo(today, trip.startYmd);
    if (!deps.remindDays.includes(days)) continue;
    if (trip.endYmd < today) continue;
    const weather = days === WEATHER_DAY ? await weatherLine(ctx, deps, trip) : undefined;
    await notifier.notify({
      kind: 'trip.checklist',
      dedupeKey: `${trip.id}:${days}`,
      text: checklistNotice(trip, days, deps.texts, weather),
    });
  }
}

/** Registers the daily D-N checklist for each trip that starts in a configured number of days. */
export function registerTripChecklist(ctx: PluginContext, deps: ChecklistDeps, at: string): void {
  ctx.scheduler.add({
    name: CHECKLIST_JOB,
    schedule: { kind: 'daily', at: at as `${number}:${number}` },
    run: (now) => sendChecklists(ctx, deps, now),
  });
}
