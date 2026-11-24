import type { PhoneDayTotals, PhoneLocation, PhoneSignals } from '../core/contracts/index.js';
import type { Clock } from '../core/scheduler/types.js';
import { wallClock } from '../core/scheduler/next-run.js';
import type { KeyValueStore } from '../core/store/types.js';
import type { IngestItem } from './schema.js';

interface StoredLocation {
  lat: number;
  lng: number;
  label?: string;
  at: string;
}

interface StoredDay {
  steps?: number;
  screenMinutes?: number;
}

const LOCATIONS_KEY = 'locations';
const DAYS_KEY = 'days';
const LAST_SEEN_KEY = 'lastSeen';
const BATTERY_KEY = 'battery';
const MAX_LOCATIONS = 50;
const MAX_DAYS = 60;

function ymdOf(date: Date, timeZone: string): string {
  const parts = wallClock(date, timeZone);
  return `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
}

function capDays(days: Record<string, StoredDay>): Record<string, StoredDay> {
  const keys = Object.keys(days).sort((a, b) => b.localeCompare(a)).slice(0, MAX_DAYS);
  const capped: Record<string, StoredDay> = {};
  for (const key of keys) {
    const day = days[key];
    if (day !== undefined) capped[key] = day;
  }
  return capped;
}

/** Latest phone signals in kv, bounded: 50 locations and 60 daily totals. Provides "phone.signals". */
export class SampleStore implements PhoneSignals {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly clock: Clock,
    private readonly timeZone: string,
  ) {}

  async record(items: readonly IngestItem[], at: Date): Promise<void> {
    const storedLocations = await this.kv.get<StoredLocation[]>(LOCATIONS_KEY);
    let locations = Array.isArray(storedLocations) ? storedLocations : [];
    const storedDays = await this.kv.get<Record<string, StoredDay>>(DAYS_KEY);
    const days: Record<string, StoredDay> = storedDays !== undefined ? { ...storedDays } : {};
    let changedLocations = false;
    let changedDays = false;
    let changedBattery = false;
    let battery: { level: number; at: string } | undefined;

    for (const item of items) {
      if (item.kind === 'location') {
        locations = [
          {
            lat: item.lat,
            lng: item.lng,
            ...(item.label !== undefined ? { label: item.label } : {}),
            at: item.at.toISOString(),
          },
          ...locations,
        ].slice(0, MAX_LOCATIONS);
        changedLocations = true;
      } else if (item.kind === 'steps' || item.kind === 'screen_time') {
        const ymd = item.date ?? ymdOf(item.at, this.timeZone);
        const day: StoredDay = days[ymd] ?? {};
        if (item.kind === 'steps') {
          day.steps = Math.max(day.steps ?? 0, item.steps);
        } else {
          day.screenMinutes = Math.max(day.screenMinutes ?? 0, item.minutes);
        }
        days[ymd] = day;
        changedDays = true;
      } else if (item.kind === 'battery') {
        battery = { level: item.level, at: item.at.toISOString() };
        changedBattery = true;
      }
    }

    if (changedLocations) await this.kv.set(LOCATIONS_KEY, locations);
    if (changedDays) await this.kv.set(DAYS_KEY, capDays(days));
    if (changedBattery && battery !== undefined) await this.kv.set(BATTERY_KEY, battery);
    await this.kv.set(LAST_SEEN_KEY, at.toISOString());
  }

  async latestLocation(maxAgeMinutes: number): Promise<PhoneLocation | undefined> {
    const stored = await this.kv.get<StoredLocation[]>(LOCATIONS_KEY);
    const threshold = this.clock.now().getTime() - maxAgeMinutes * 60_000;
    const found = (Array.isArray(stored) ? stored : []).find((entry) => Date.parse(entry.at) >= threshold);
    if (found === undefined) return undefined;
    return {
      lat: found.lat,
      lng: found.lng,
      at: new Date(found.at),
      ...(found.label !== undefined ? { label: found.label } : {}),
    };
  }

  async dayTotals(ymd: string): Promise<PhoneDayTotals> {
    const stored = await this.kv.get<Record<string, StoredDay>>(DAYS_KEY);
    const day = stored?.[ymd];
    if (day === undefined) return {};
    return {
      ...(day.steps !== undefined ? { steps: day.steps } : {}),
      ...(day.screenMinutes !== undefined ? { screenMinutes: day.screenMinutes } : {}),
    };
  }

  async lastSeen(): Promise<Date | undefined> {
    const stored = await this.kv.get<string>(LAST_SEEN_KEY);
    if (typeof stored !== 'string') return undefined;
    const parsed = Date.parse(stored);
    return Number.isFinite(parsed) ? new Date(parsed) : undefined;
  }
}
