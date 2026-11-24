import { z } from 'zod';

export type EmptyTextKind = 'sms' | 'notification' | 'voice_memo';

export type IngestItem =
  | { kind: 'location'; at: Date; lat: number; lng: number; label?: string; accuracy?: number }
  | { kind: 'steps'; at: Date; steps: number; date?: string }
  | { kind: 'screen_time'; at: Date; minutes: number; date?: string }
  | { kind: 'sms'; at: Date; from?: string; text: string }
  | { kind: 'notification'; at: Date; app: string; title?: string; text: string }
  | { kind: 'voice_memo'; at: Date; text: string }
  | { kind: 'battery'; at: Date; level: number };

export type IngestParseResult =
  | { ok: true; at: Date; items: IngestItem[] }
  | { ok: false; error: 'shape' }
  | { ok: false; error: 'stale' }
  | { ok: false; error: 'empty'; kind: EmptyTextKind };

export interface ParseOptions {
  now: Date;
  timeZone: string;
}

const MAX_SKEW_MS = 5 * 60_000;
/** A queued item (the phone app was offline) may carry its own time, up to two days old. */
const MAX_ITEM_AGE_MS = 48 * 60 * 60_000;

const versionSchema = z.preprocess(
  (value) => (typeof value === 'string' ? Number(value.trim()) : value),
  z.literal(1),
);

function numericValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : Number(trimmed);
}

const numericSchema = z.preprocess(numericValue, z.number().finite());

const coordinateSchema = z.preprocess(
  (value) => (typeof value === 'string' ? numericValue(value.replace(/,/g, '.')) : value),
  z.number().finite(),
);

function text(max: number): z.ZodType<string> {
  return z.string().transform((value) => value.trim().slice(0, max));
}

const ymdSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const rawItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('location'),
    lat: coordinateSchema.pipe(z.number().min(-90).max(90)),
    lng: coordinateSchema.pipe(z.number().min(-180).max(180)),
    label: text(200).optional(),
    accuracy: numericSchema.pipe(z.number().min(0).max(100_000)).optional(),
  }),
  z.object({
    kind: z.literal('steps'),
    steps: numericSchema.pipe(z.number().min(0).max(200_000)).optional(),
    count: numericSchema.pipe(z.number().min(0).max(200_000)).optional(),
    date: ymdSchema.optional(),
  }),
  z.object({
    kind: z.literal('screen_time'),
    minutes: numericSchema.pipe(z.number().min(0).max(1440)),
    date: ymdSchema.optional(),
  }),
  z.object({ kind: z.literal('sms'), from: text(200).optional(), text: text(1000) }),
  z.object({
    kind: z.literal('notification'),
    app: text(200),
    title: text(200).optional(),
    text: text(200),
  }),
  z.object({ kind: z.literal('voice_memo'), text: text(8000) }),
  z.object({ kind: z.literal('battery'), level: numericSchema.pipe(z.number().min(0).max(100)) }),
]);

type RawItem = z.infer<typeof rawItemSchema>;

const envelopeSchema = z
  .object({
    v: versionSchema,
    items: z.array(z.unknown()).min(1).max(50).optional(),
  })
  .catchall(z.unknown());

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

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
      hourCycle: 'h23',
    });
    formatters.set(timeZone, cached);
  }
  return cached;
}

function zoneOffsetMs(instant: number, timeZone: string): number {
  const values: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }
  const wall = Date.UTC(
    Number(values['year']),
    Number(values['month']) - 1,
    Number(values['day']),
    Number(values['hour']),
    Number(values['minute']),
    Number(values['second']),
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

function localWallTime(
  y: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): Date | undefined {
  try {
    const wall = Date.UTC(y, month - 1, day, hour, minute, second, ms);
    let instant = wall - zoneOffsetMs(wall, timeZone);
    instant = wall - zoneOffsetMs(instant, timeZone);
    return new Date(instant);
  } catch {
    return undefined;
  }
}

function epochDate(value: number): Date | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const ms = value >= 1e11 ? value : value * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Accepts ISO 8601, epoch seconds or ms (number or numeric string), or a wall clock in the owner's zone. */
export function parseTimestamp(value: unknown, timeZone: string): Date | undefined {
  if (typeof value === 'number') return epochDate(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return epochDate(Number(trimmed));
  const wall = WALL_CLOCK.exec(trimmed);
  if (wall !== null) {
    return localWallTime(
      Number(wall[1]),
      Number(wall[2]),
      Number(wall[3]),
      Number(wall[4]),
      Number(wall[5]),
      Number(wall[6] ?? '0'),
      Number((wall[7] ?? '0').padEnd(3, '0')),
      timeZone,
    );
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed) : undefined;
}

function normalizeKind(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const kind = record['kind'];
  if (typeof kind !== 'string') return value;
  return { ...record, kind: kind.trim().toLowerCase() };
}

function batteryLevel(value: number): number | undefined {
  const level = value <= 1 ? value * 100 : value;
  if (!Number.isFinite(level) || level < 0 || level > 100) return undefined;
  return Math.round(level);
}

function toItem(raw: RawItem, at: Date): IngestItem | undefined {
  switch (raw.kind) {
    case 'location':
      return {
        kind: 'location',
        at,
        lat: raw.lat,
        lng: raw.lng,
        ...(raw.label !== undefined ? { label: raw.label } : {}),
        ...(raw.accuracy !== undefined ? { accuracy: raw.accuracy } : {}),
      };
    case 'steps': {
      const steps = raw.steps ?? raw.count;
      if (steps === undefined) return undefined;
      return { kind: 'steps', at, steps: Math.round(steps), ...(raw.date !== undefined ? { date: raw.date } : {}) };
    }
    case 'screen_time':
      return {
        kind: 'screen_time',
        at,
        minutes: Math.round(raw.minutes),
        ...(raw.date !== undefined ? { date: raw.date } : {}),
      };
    case 'sms':
      return { kind: 'sms', at, text: raw.text, ...(raw.from !== undefined ? { from: raw.from } : {}) };
    case 'notification':
      return {
        kind: 'notification',
        at,
        app: raw.app,
        text: raw.text,
        ...(raw.title !== undefined ? { title: raw.title } : {}),
      };
    case 'voice_memo':
      return { kind: 'voice_memo', at, text: raw.text };
    case 'battery': {
      const level = batteryLevel(raw.level);
      return level === undefined ? undefined : { kind: 'battery', at, level };
    }
  }
}

function emptyKind(item: IngestItem): EmptyTextKind | undefined {
  if (item.kind === 'sms' || item.kind === 'voice_memo' || item.kind === 'notification') {
    return item.text.trim() === '' ? item.kind : undefined;
  }
  return undefined;
}

function itemTime(candidate: unknown, envelopeAt: Date, options: ParseOptions): Date | 'stale' {
  if (typeof candidate !== 'object' || candidate === null) return envelopeAt;
  const raw = (candidate as Record<string, unknown>)['at'];
  if (raw === undefined || raw === null || raw === '') return envelopeAt;
  const at = parseTimestamp(raw, options.timeZone);
  if (at === undefined) return 'stale';
  const age = options.now.getTime() - at.getTime();
  return age > MAX_ITEM_AGE_MS || age < -MAX_SKEW_MS ? 'stale' : at;
}

/** Parses both the `items` envelope and the flat dictionary an iOS Shortcut sends. */
export function parseIngestBody(raw: unknown, options: ParseOptions): IngestParseResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'shape' };
  const record = raw as Record<string, unknown>;
  const ts = record['ts'];
  if (ts === undefined || ts === null) return { ok: false, error: 'shape' };
  const envelope = envelopeSchema.safeParse(record);
  if (!envelope.success) return { ok: false, error: 'shape' };
  const at = parseTimestamp(ts, options.timeZone);
  if (at === undefined) return { ok: false, error: 'shape' };
  if (Math.abs(options.now.getTime() - at.getTime()) > MAX_SKEW_MS) return { ok: false, error: 'stale' };

  const candidates = record['items'] !== undefined ? record['items'] : [record];
  if (!Array.isArray(candidates)) return { ok: false, error: 'shape' };
  const items: IngestItem[] = [];
  for (const candidate of candidates) {
    const parsed = rawItemSchema.safeParse(normalizeKind(candidate));
    if (!parsed.success) return { ok: false, error: 'shape' };
    const itemAt = itemTime(candidate, at, options);
    if (itemAt === 'stale') return { ok: false, error: 'stale' };
    const item = toItem(parsed.data, itemAt);
    if (item === undefined) return { ok: false, error: 'shape' };
    const empty = emptyKind(item);
    if (empty !== undefined) return { ok: false, error: 'empty', kind: empty };
    items.push(item);
  }
  if (items.length === 0) return { ok: false, error: 'shape' };
  return { ok: true, at, items };
}
