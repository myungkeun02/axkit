const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HOUR_MS = 3_600_000;
const WINDOW_MS = 36 * HOUR_MS;
const formatters = new Map<string, Intl.DateTimeFormat>();

export interface WallClock {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  weekday: string;
}

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatters.get(timeZone);
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

interface ZoneParts extends WallClock {
  ss: number;
}

function zoneParts(instant: number, timeZone: string): ZoneParts {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  return {
    y: Number(values.year),
    m: Number(values.month),
    d: Number(values.day),
    hh: Number(values.hour),
    mm: Number(values.minute),
    ss: Number(values.second),
    weekday: values.weekday ?? '',
  };
}

export function wallClock(d: Date, timeZone: string): WallClock {
  const parts = zoneParts(d.getTime(), timeZone);
  return { y: parts.y, m: parts.m, d: parts.d, hh: parts.hh, mm: parts.mm, weekday: parts.weekday };
}

function offsetAt(instant: number, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(instant / 1000) * 1000;
}

function matches(p: ZoneParts, y: number, m: number, d: number, hh: number, mm: number): boolean {
  return p.y === y && p.m === m && p.d === d && p.hh === hh && p.mm === mm;
}

function findTransition(timeZone: string, y: number, m: number, d: number, hh: number, mm: number): number | undefined {
  const targetWall = Date.UTC(y, m - 1, d, hh, mm);
  const start = targetWall - WINDOW_MS;
  const end = targetWall + WINDOW_MS;
  let previousT = start;
  let previousOffset = offsetAt(start, timeZone);
  for (let t = start + HOUR_MS; t <= end; t += HOUR_MS) {
    const offset = offsetAt(t, timeZone);
    if (offset !== previousOffset) {
      let lo = previousT;
      let hi = t;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetAt(mid, timeZone) === previousOffset) lo = mid;
        else hi = mid;
      }
      const transition = hi;
      if (offset > previousOffset && targetWall > transition + previousOffset && targetWall < transition + offset) {
        return transition;
      }
      previousOffset = offset;
    }
    previousT = t;
  }
  return undefined;
}

/** Instants whose wall clock in the zone equals the requested local time. Empty for a skipped (DST) time. */
function instantsForLocal(
  timeZone: string,
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
): number[] {
  const targetWall = Date.UTC(y, m - 1, d, hh, mm);
  const offsets = new Set<number>([
    offsetAt(targetWall - WINDOW_MS, timeZone),
    offsetAt(targetWall + WINDOW_MS, timeZone),
    offsetAt(targetWall - WINDOW_MS / 2, timeZone),
    offsetAt(targetWall + WINDOW_MS / 2, timeZone),
  ]);
  const matchesFound: number[] = [];
  for (const offset of offsets) {
    const candidate = targetWall - offset;
    if (matches(zoneParts(candidate, timeZone), y, m, d, hh, mm)) matchesFound.push(candidate);
  }
  return [...new Set(matchesFound)].sort((a, b) => a - b);
}

function parseAt(at: string): { hh: number; mm: number } {
  const match = HHMM.exec(at);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new RangeError(`Invalid daily time "${at}": expected HH:MM`);
  }
  return { hh: Number(match[1]), mm: Number(match[2]) };
}

function assertTimeZone(timeZone: string): void {
  try {
    formatter(timeZone);
  } catch {
    throw new RangeError(`Invalid time zone "${timeZone}"`);
  }
}

/** Next instant strictly after `now` whose wall clock in `timeZone` reads HH:MM. */
export function nextDailyRun(now: Date, at: string, timeZone: string): Date {
  const { hh, mm } = parseAt(at);
  assertTimeZone(timeZone);
  const current = wallClock(now, timeZone);
  const threshold = now.getTime();
  for (let dayOffset = 0; dayOffset <= 7; dayOffset += 1) {
    const day = new Date(Date.UTC(current.y, current.m - 1, current.d + dayOffset));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const candidates = instantsForLocal(timeZone, y, m, d, hh, mm);
    if (candidates.length === 0) {
      const transition = findTransition(timeZone, y, m, d, hh, mm);
      if (transition !== undefined && transition > threshold) return new Date(transition);
      continue;
    }
    const next = candidates.find((candidate) => candidate > threshold);
    if (next !== undefined) return new Date(next);
  }
  throw new RangeError(`Could not compute the next run for ${at} in ${timeZone}`);
}

/** First instant of the local calendar day y-m-d in the zone (midnight, or the first minute after a DST gap). */
export function startOfLocalDay(y: number, m: number, d: number, timeZone: string): Date {
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    const found = instantsForLocal(timeZone, y, m, d, Math.floor(minute / 60), minute % 60)[0];
    if (found !== undefined) return new Date(found);
  }
  throw new RangeError(`No local day ${y}-${m}-${d} in ${timeZone}`);
}
