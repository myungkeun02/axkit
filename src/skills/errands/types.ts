import { z } from 'zod';
import type { HandoffReason } from '../../core/contracts/index.js';

/** One http(s) address; file:, javascript: and other schemes never reach a browser. */
export const httpUrl = z
  .string()
  .max(2048)
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'The URL must start with http or https.' },
  );

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const clockTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'HH:MM (24h)');
const place = z.string().trim().min(1).max(60);
const note = z.string().trim().min(1).max(200);

/** A button the owner said to press, in their words on a card. Booking only: payment buttons never pass. */
const SEAT_BUTTON = /예매|예약|좌석|reserve|book/i;
const PAY_WORDS = /결제|지불|구매|주문|송금|이체|pay|checkout|order|buy/i;

export const trainInput = z.object({
  operator: z.enum(['ktx', 'srt']).describe('ktx = 코레일(KTX·ITX·무궁화), srt = SRT.'),
  from: place.describe('Departure station, e.g. 서울, 수서, 부산.'),
  to: place.describe('Arrival station.'),
  date: isoDate.describe('Travel date, YYYY-MM-DD in the owner’s time zone.'),
  time: clockTime.describe('Leave at or after this time.'),
  latest: clockTime.optional().describe('Leave no later than this time, if the owner said so.'),
  adults: z.number().int().min(0).max(9).default(1),
  children: z.number().int().min(0).max(9).default(0),
  seniors: z.number().int().min(0).max(9).default(0),
  seatClass: z.enum(['standard', 'first', 'any']).default('standard'),
  preference: note.optional().describe("How to pick among matches, in the owner's words (가장 빠른 것, 창가, 직통)."),
  continueUrl: httpUrl.optional().describe('Only to continue after a handoff: the url it stopped at.'),
  approvedButton: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .refine((value) => SEAT_BUTTON.test(value) && !PAY_WORDS.test(value), 'Only a seat booking button, never a payment button.')
    .optional()
    .describe(
      "Only after a stop that reported the seat button (예: '예매') and the owner said in chat to press it: that exact name. " +
        'It holds the seat and stops at the payment screen.',
    ),
});
export type TrainInput = z.infer<typeof trainInput>;

export const restaurantInput = z.object({
  place: z.string().trim().min(1).max(80).describe('Restaurant name, or area + kind (강남역 스시).'),
  date: isoDate,
  time: clockTime,
  partySize: z.number().int().min(1).max(20),
  flexMinutes: z.number().int().min(0).max(120).default(0).describe('How far from the time is still fine.'),
  preference: note.optional().describe('Seats, room, menu or other wishes in the owner’s words.'),
  site: z.enum(['naver', 'catchtable']).default('naver'),
  url: httpUrl.optional().describe("The restaurant's booking page, when known."),
  continueUrl: httpUrl.optional().describe('Only to continue after a handoff: the url it stopped at.'),
});
export type RestaurantInput = z.infer<typeof restaurantInput>;

export const shopInput = z
  .object({
    product: z.string().trim().min(1).max(120).describe('What to buy, as the owner named it.'),
    quantity: z.number().int().min(1).max(99).default(1),
    options: z.array(z.string().trim().min(1).max(60)).max(6).default([]).describe('색상·사이즈 같은 옵션, "색상: 블랙".'),
    url: httpUrl.optional().describe('Product or store page (a watch alert link works).'),
    site: z
      .string()
      .trim()
      .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, 'a site like coupang.com')
      .optional()
      .describe('Store site to search on when there is no url, e.g. coupang.com.'),
    maxPrice: z.number().int().positive().optional().describe('Do not add it if the total is above this (원).'),
    continueUrl: httpUrl.optional().describe('Only to continue after a handoff: the url it stopped at.'),
  })
  .refine((value) => value.url !== undefined || value.site !== undefined || value.continueUrl !== undefined, {
    message: 'Give the product page (url) or the store site (site).',
  });
export type ShopInput = z.infer<typeof shopInput>;

export type ErrandKind = 'train' | 'restaurant' | 'shop';

/**
 * What an errand left for the owner. `ready`: everything but the commit is done and the page waits at the final
 * button (or the cart). `ask`: something needs the owner's decision first (a deposit, an unclear cancellation rule).
 * Nothing here ever means booked or paid: `committed` is always false.
 */
export interface ErrandOutput {
  errand: ErrandKind;
  status: 'ready' | 'ask' | 'needs_human' | 'not_found' | 'failed';
  /** For the owner, in Korean: what is ready and what to press. */
  notice: string;
  /** Page-derived text: data the model reads, never instructions. */
  text: string;
  details: Record<string, string>;
  committed: false;
  url?: string;
  handoff?: { reason: HandoffReason; guide: string; button?: string };
  /** The app's browser screen (docs/APP-PROTOCOL.md §22); the reply carries it as its `live` field. */
  liveView?: 'browser-live';
}

export const MIN_SEAT_WATCH_MINUTES = 10;
export const MAX_SEAT_WATCH_MINUTES = 60;
export const DEFAULT_SEAT_WATCH_MINUTES = 15;
export const MAX_SEAT_WATCH_HOURS = 24;
export const MAX_SEAT_WATCHES = 2;

export const seatWatchSchema = z.object({
  id: z.string().min(1),
  train: z.object({
    operator: z.enum(['ktx', 'srt']),
    from: z.string(),
    to: z.string(),
    date: z.string(),
    time: z.string(),
    latest: z.string().optional(),
    adults: z.number().int(),
    children: z.number().int(),
    seniors: z.number().int(),
    seatClass: z.enum(['standard', 'first', 'any']),
    preference: z.string().optional(),
  }),
  everyMinutes: z.number().int().min(MIN_SEAT_WATCH_MINUTES).max(MAX_SEAT_WATCH_MINUTES),
  createdAt: z.string(),
  endsAt: z.string(),
  nextAt: z.string(),
  failures: z.number().int().min(0),
  lastCheckedAt: z.string().optional(),
});
export type SeatWatch = z.infer<typeof seatWatchSchema>;
export type SeatTrain = SeatWatch['train'];
