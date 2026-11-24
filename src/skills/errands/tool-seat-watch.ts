import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Tool } from '../../core/tools/types.js';
import { trainLine } from './locale.js';
import { pastDate } from './run.js';
import type { SweepDeps } from './seat-watch.js';
import type { SeatTrain, SeatWatch } from './types.js';
import { DEFAULT_SEAT_WATCH_MINUTES, MAX_SEAT_WATCH_HOURS, MAX_SEAT_WATCH_MINUTES, MIN_SEAT_WATCH_MINUTES, trainInput } from './types.js';

const watchInput = trainInput
  .omit({ continueUrl: true, approvedButton: true })
  .extend({
    everyMinutes: z
      .number()
      .int()
      .min(MIN_SEAT_WATCH_MINUTES)
      .max(MAX_SEAT_WATCH_MINUTES)
      .default(DEFAULT_SEAT_WATCH_MINUTES)
      .describe('Minutes between checks, 10 to 60. Booking sites treat frequent checks as a macro.'),
    hours: z.number().int().min(1).max(MAX_SEAT_WATCH_HOURS).default(12).describe('Stop after this many hours (at most 24).'),
  });
export type SeatWatchInput = z.infer<typeof watchInput>;

function trainOf(value: SeatWatchInput): SeatTrain {
  return {
    operator: value.operator,
    from: value.from,
    to: value.to,
    date: value.date,
    time: value.time,
    ...(value.latest !== undefined ? { latest: value.latest } : {}),
    adults: value.adults,
    children: value.children,
    seniors: value.seniors,
    seatClass: value.seatClass,
    ...(value.preference !== undefined ? { preference: value.preference } : {}),
  };
}

function localTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', { timeZone, month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/** Opt-in per request: low frequency, at most 24 hours, notify only. It never books. */
export function seatWatchTool(deps: SweepDeps): Tool<SeatWatchInput, { started: boolean; message: string; id?: string }> {
  return {
    name: 'errands.seat_watch',
    description:
      'Only when the owner asks to be told if a sold-out train frees up: checks the search every 10–60 minutes ' +
      '(default 15) for at most 24 hours and notifies when a seat appears. It never selects or books a seat; to book, ' +
      'the owner asks and you call errands.train. At most two watches at once. Never offer a shorter interval.',
    input: watchInput,
    effects: ['write'],
    describe: (value) => deps.texts.watchCard(trainOf(value), value.everyMinutes, value.hours),
    // the owner agrees to the frequency and the end on a card each time
    uncertainty: () => deps.texts.watchCardNote,
    reject: (value) => pastDate(value.date, deps.ctx.assistant.timezone, deps.ctx.clock.now()),
    async run(value) {
      const now = deps.ctx.clock.now();
      const watch: SeatWatch = {
        id: `seat-${randomUUID().slice(0, 8)}`,
        train: trainOf(value),
        everyMinutes: value.everyMinutes,
        createdAt: now.toISOString(),
        endsAt: new Date(now.getTime() + value.hours * 3_600_000).toISOString(),
        // the first look waits one interval too: the owner just searched and found nothing
        nextAt: new Date(now.getTime() + value.everyMinutes * 60_000).toISOString(),
        failures: 0,
      };
      if (!(await deps.store.add(watch))) return { started: false, message: deps.texts.watchFull };
      return { started: true, id: watch.id, message: deps.texts.watchAdded(watch, localTime(watch.endsAt, deps.ctx.assistant.timezone)) };
    },
  };
}

export function seatWatchListTool(deps: SweepDeps): Tool<Record<string, never>, { watches: { id: string; train: string; everyMinutes: number; endsAt: string }[]; message?: string }> {
  return {
    name: 'errands.seat_watch_list',
    description: 'Lists the train seat watches that are running.',
    input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    effects: ['read'],
    async run() {
      const watches = deps.store.all().map((watch) => ({
        id: watch.id,
        train: trainLine(watch.train),
        everyMinutes: watch.everyMinutes,
        endsAt: localTime(watch.endsAt, deps.ctx.assistant.timezone),
      }));
      return watches.length === 0 ? { watches, message: deps.texts.watchNone } : { watches };
    },
  };
}

const stopInput = z.object({ id: z.string().min(1).max(40) });

export function seatWatchStopTool(deps: SweepDeps): Tool<z.infer<typeof stopInput>, { stopped: boolean; message: string }> {
  return {
    name: 'errands.seat_watch_stop',
    description: 'Stops one train seat watch by id (from errands.seat_watch_list).',
    input: stopInput,
    effects: ['write'],
    describe: (value) => deps.texts.stopDescribe(value.id),
    async run(value) {
      const removed = await deps.store.remove(value.id);
      return removed === undefined ? { stopped: false, message: deps.texts.watchNone } : { stopped: true, message: deps.texts.watchStopped(removed) };
    },
  };
}
