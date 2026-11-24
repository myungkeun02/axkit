import { wallClock } from '../../core/scheduler/next-run.js';

/** The KMA service only accepts Korean local time; this is an API rule, not the owner's zone. */
const KST = 'Asia/Seoul';

const RE = 6371.00877;
const GRID = 5.0;
const SLAT1 = 30.0;
const SLAT2 = 60.0;
const OLON = 126.0;
const OLAT = 38.0;
const XO = 43;
const YO = 136;
const DEGRAD = Math.PI / 180;

/** Every short-term forecast slot, in KST hours. Values appear 10 minutes after the slot. */
const FORECAST_HOURS = [2, 5, 8, 11, 14, 17, 20, 23] as const;
const FORECAST_DELAY_MIN = 10;
const ULTRA_DELAY_MIN = 40;

export interface KmaBase {
  baseDate: string;
  baseTime: string;
}

export interface KstWall {
  /** YYYYMMDD, the format the KMA service wants. */
  ymd: string;
  hh: number;
  mm: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function ymdOf(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}${pad2(m)}${pad2(d)}`;
}

function previousDay(y: number, m: number, d: number): string {
  const date = new Date(Date.UTC(y, m - 1, d - 1));
  return ymdOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

export function kstWall(now: Date): KstWall {
  const wall = wallClock(now, KST);
  return { ymd: ymdOf(wall.y, wall.m, wall.d), hh: wall.hh, mm: wall.mm };
}

/** WGS84 → the official LCC grid (nx, ny). Seoul City Hall is 60, 127. */
export function kmaGrid(lat: number, lng: number): { nx: number; ny: number } {
  const re = RE / GRID;
  const slat1 = SLAT1 * DEGRAD;
  const slat2 = SLAT2 * DEGRAD;
  const olon = OLON * DEGRAD;
  const olat = OLAT * DEGRAD;

  const sn =
    Math.log(Math.cos(slat1) / Math.cos(slat2)) /
    Math.log(Math.tan(Math.PI * 0.25 + slat2 * 0.5) / Math.tan(Math.PI * 0.25 + slat1 * 0.5));
  const sf = Math.pow(Math.tan(Math.PI * 0.25 + slat1 * 0.5), sn) * Math.cos(slat1) / sn;
  const ro = re * sf / Math.pow(Math.tan(Math.PI * 0.25 + olat * 0.5), sn);
  const ra = re * sf / Math.pow(Math.tan(Math.PI * 0.25 + (lat * DEGRAD) * 0.5), sn);

  let theta = lng * DEGRAD - olon;
  if (theta > Math.PI) theta -= 2 * Math.PI;
  if (theta < -Math.PI) theta += 2 * Math.PI;
  theta *= sn;

  return {
    nx: Math.floor(ra * Math.sin(theta) + XO + 0.5),
    ny: Math.floor(ro - ra * Math.cos(theta) + YO + 0.5),
  };
}

/** Latest short-term forecast slot available at `now`. */
export function forecastBase(now: Date): KmaBase {
  const wall = kstWall(now);
  const minutes = wall.hh * 60 + wall.mm;
  let chosen: number | undefined;
  for (const hour of FORECAST_HOURS) {
    if (minutes >= hour * 60 + FORECAST_DELAY_MIN) chosen = hour;
  }
  if (chosen === undefined) {
    const parts = wallYmd(now);
    return { baseDate: previousDay(parts.y, parts.m, parts.d), baseTime: '2300' };
  }
  return { baseDate: wall.ymd, baseTime: `${pad2(chosen)}00` };
}

/** Latest hourly observation available at `now`. */
export function ultraBase(now: Date): KmaBase {
  const wall = kstWall(now);
  if (wall.mm >= ULTRA_DELAY_MIN) return { baseDate: wall.ymd, baseTime: `${pad2(wall.hh)}00` };
  if (wall.hh === 0) {
    const parts = wallYmd(now);
    return { baseDate: previousDay(parts.y, parts.m, parts.d), baseTime: '2300' };
  }
  return { baseDate: wall.ymd, baseTime: `${pad2(wall.hh - 1)}00` };
}

function wallYmd(now: Date): { y: number; m: number; d: number } {
  const wall = wallClock(now, KST);
  return { y: wall.y, m: wall.m, d: wall.d };
}
