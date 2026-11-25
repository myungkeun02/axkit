import { z } from 'zod';
import { zonedIso } from '../../core/time/date-spec.js';
import { ymdOf, ymdPlus } from '../../core/time/local-day.js';
import { hhmmOf } from './day-range.js';

/** Page text is data: strip control and markup characters and clip it before it reaches the owner. */
export function cleanText(s: string, max = 60): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what this strips
  return s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[<>@`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const text = (max: number) => z.string().transform((s) => cleanText(s, max));
const optInt = (max: number) => z.number().int().min(0).max(max).nullish().transform((v) => v ?? undefined);
/** A headway range such as "14-24" keeps its longer end (the wait to plan for). */
function headway(v: unknown): unknown {
  if (typeof v === 'string') {
    const n = v.match(/\d+/g)?.map(Number) ?? [];
    return n.length > 0 ? Math.max(...n) : undefined;
  }
  return v;
}
const optText = (max: number) => text(max).nullish().transform((v) => (v === undefined || v === null || v === '' ? undefined : v));

const LegSchema = z.object({
  md: z.enum(['subway', 'bus', 'walk']),
  ln: optText(40),
  fr: optText(40),
  to: optText(40),
  st: optInt(200),
  rd: optInt(600),
  hw: z.preprocess(headway, optInt(240)),
  nx: z.array(z.string().regex(HHMM)).max(4).nullish().transform((v) => v ?? []),
  pf: optText(40),
});
const RouteSchema = z.object({
  m: z.number().int().min(1).max(1000),
  tr: z.number().int().min(0).max(10),
  w: z.number().int().min(0).max(600),
  fare: z.number().int().min(0).max(100_000).nullish().transform((v) => v ?? undefined),
  legs: z.array(z.unknown()).max(10),
});

export interface Leg {
  mode: 'subway' | 'bus' | 'walk';
  line?: string;
  from?: string;
  to?: string;
  stops?: number;
  rideMin?: number;
  headwayMin?: number;
  next: string[];
  platform?: string;
}
export interface Route {
  totalMin: number;
  transfers: number;
  walkMin: number;
  fareKrw?: number;
  legs: Leg[];
}

const SHAPE =
  '답은 JSON 하나만: {"routes":[{"m":총분,"tr":환승수,"w":도보분,"fare":원,"legs":[{"md":"subway|bus|walk","ln":노선,"fr":타는곳,"to":내리는곳,"st":정거장수,"rd":탑승분,"hw":배차간격분,"nx":["HH:MM" 다음 출발 시각 최대 4개],"pf":승강장}]}]} 상위 2경로만. 못 찾으면 {"routes":[]}.';

export interface QueryInput {
  from: string;
  to: string;
  arriveBy?: Date;
  departAt?: Date;
  timeZone: string;
}

function dayLabel(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone, month: 'numeric', day: 'numeric', weekday: 'short' }).format(at);
}

/** The look-only task for the browser agent. The full date and weekday matter: timetables differ by day. */
export function buildTransitTask(i: QueryInput): string {
  const at = (d: Date): string => `${dayLabel(d, i.timeZone)} ${hhmmOf(d.toISOString(), i.timeZone) ?? ''}`;
  const when = i.arriveBy !== undefined ? `${at(i.arriveBy)} 도착` : i.departAt !== undefined ? `${at(i.departAt)} 출발` : '지금 출발';
  return `네이버 지도(안 되면 카카오맵)에서 대중교통 길찾기를 읽기만 해 줘(로그인·제출 없이). 출발 "${cleanText(i.from, 40)}" 도착 "${cleanText(i.to, 40)}" ${when}. ${SHAPE}`;
}

function jsonIn(answer: string): unknown {
  const start = answer.indexOf('{');
  const end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(answer.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Routes in the agent's answer, fastest first. A malformed route is dropped; nothing here throws. */
export function parseRoutes(answer: string): Route[] {
  const raw = jsonIn(answer);
  const list = typeof raw === 'object' && raw !== null && Array.isArray((raw as { routes?: unknown }).routes) ? (raw as { routes: unknown[] }).routes : [];
  const out: Route[] = [];
  for (const item of list.slice(0, 2)) {
    const summary = RouteSchema.safeParse(item);
    if (!summary.success) continue;
    const legs: Leg[] = [];
    let bad = false;
    for (const rawLeg of summary.data.legs) {
      const parsed = LegSchema.safeParse(rawLeg);
      if (!parsed.success) {
        bad = true;
        break;
      }
      const l = parsed.data;
      legs.push({
        mode: l.md,
        next: l.nx,
        ...(l.ln !== undefined ? { line: l.ln } : {}),
        ...(l.fr !== undefined ? { from: l.fr } : {}),
        ...(l.to !== undefined ? { to: l.to } : {}),
        ...(l.st !== undefined ? { stops: l.st } : {}),
        ...(l.rd !== undefined ? { rideMin: l.rd } : {}),
        ...(l.hw !== undefined ? { headwayMin: l.hw } : {}),
        ...(l.pf !== undefined ? { platform: l.pf } : {}),
      });
    }
    if (bad || legs.length === 0) continue;
    out.push({ totalMin: summary.data.m, transfers: summary.data.tr, walkMin: summary.data.w, ...(summary.data.fare !== undefined ? { fareKrw: summary.data.fare } : {}), legs });
  }
  return out.sort((a, b) => a.totalMin - b.totalMin);
}

export interface Departure {
  departAt: Date;
  boardAt?: Date;
  rounded: boolean;
}

function atZone(ymd: string, time: string, timeZone: string): Date {
  return new Date(zonedIso(ymd, time, timeZone));
}

/** Leave so the walk to the first stop, the ride and the buffer fit before the start; snapped to a real departure. */
export function recommendDeparture(startAt: Date, route: Route, bufferMin: number, timeZone: string): Departure {
  const latest = new Date(startAt.getTime() - (route.totalMin + bufferMin) * 60_000);
  const firstIdx = route.legs.findIndex((l) => l.mode !== 'walk');
  const first = route.legs[firstIdx];
  if (firstIdx < 0 || first === undefined) return { departAt: latest, rounded: false };
  const walk0 = route.legs.slice(0, firstIdx).reduce((sum, l) => sum + (l.rideMin ?? 0), 0);
  const target = latest.getTime() + walk0 * 60_000;
  const base = ymdOf(latest, timeZone);
  const candidates: number[] = [];
  for (const t of first.next) for (const off of [-1, 0, 1]) candidates.push(atZone(ymdPlus(base, off), t, timeZone).getTime());
  const ok = candidates.filter((c) => c <= target && c >= target - 45 * 60_000).sort((a, b) => b - a)[0];
  if (ok === undefined) return { departAt: latest, rounded: false };
  return { departAt: new Date(ok - walk0 * 60_000), boardAt: new Date(ok), rounded: true };
}

/** The listed HH:MM times still ahead of `now` (within six hours), soonest first. */
export function upcomingTimes(times: readonly string[], now: Date, timeZone: string, horizonMin = 360): string[] {
  const today = ymdOf(now, timeZone);
  const out: { ts: number; t: string }[] = [];
  for (const t of times) {
    let ts = atZone(today, t, timeZone).getTime();
    if (ts < now.getTime()) ts += 86_400_000;
    if (ts - now.getTime() <= horizonMin * 60_000) out.push({ ts, t });
  }
  return out.sort((a, b) => a.ts - b.ts).map((x) => x.t);
}

export function fmtDuration(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? (m > 0 ? `${String(h)}시간 ${String(m)}분` : `${String(h)}시간`) : `${String(m)}분`;
}

const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥'];

function legLabel(l: Leg): string {
  if (l.mode === 'bus') {
    const line = l.line ?? '';
    return `${line !== '' ? (/번$|번 /.test(line) ? line : `${line}번`) : ''} 버스`.trim();
  }
  return l.line ?? '지하철';
}

function legLine(l: Leg): string {
  const span = l.from !== undefined && l.to !== undefined ? ` (${l.from} → ${l.to})` : '';
  const head = `${legLabel(l)}${span}${l.headwayMin !== undefined ? ` 배차 ${String(l.headwayMin)}분` : ''}`;
  const tail = [l.next.length > 0 ? `다음 ${l.next.join(', ')}` : '', l.platform ?? ''].filter((part) => part !== '');
  return [head, ...tail].join(' · ');
}

function summaryParen(r: Route): string {
  return [fmtDuration(r.totalMin), `환승 ${String(r.transfers)}`, `도보 ${String(r.walkMin)}분`, r.fareKrw !== undefined ? `${r.fareKrw.toLocaleString('ko-KR')}원` : ''].filter((part) => part !== '').join(', ');
}

export function routeLines(r: Route): string[] {
  const rides = r.legs.filter((l) => l.mode !== 'walk');
  if (rides.length === 0) return [`도보 ${String(r.walkMin > 0 ? r.walkMin : r.totalMin)}분`];
  return rides.map((l, i) => `${CIRCLED[i] ?? '·'} ${legLine(l)}`);
}

export interface CardInput {
  title: string;
  startAt: Date;
  routes: Route[];
  departure?: Departure;
  originNote?: string;
  update?: boolean;
  timeZone: string;
}

/** "🚇 11. 26. (목) 14:00 고객 미팅 → 추천 경로 (35분, 환승 1, 도보 8분, 1,450원)" with when to leave and each ride. */
export function formatCard(c: CardInput): string {
  const head = `${dayLabel(c.startAt, c.timeZone)} ${hhmmOf(c.startAt.toISOString(), c.timeZone) ?? ''} ${cleanText(c.title, 60)}`;
  const [best, ...rest] = c.routes;
  if (best === undefined) return `🚇 ${head}: 대중교통 경로를 찾지 못했어요. 지도 앱에서 확인해 주세요.${c.originNote !== undefined ? `\n· ${c.originNote}` : ''}`;
  const lines = [`${c.update === true ? '🔄 일정이 바뀌어 다시 안내해요\n' : ''}🚇 ${head} → 추천 경로 (${summaryParen(best)})`];
  if (c.departure !== undefined) {
    const other = ymdOf(c.departure.departAt, c.timeZone) !== ymdOf(c.startAt, c.timeZone);
    lines.push(`· ${other ? `${dayLabel(c.departure.departAt, c.timeZone)} ` : ''}${hhmmOf(c.departure.departAt.toISOString(), c.timeZone) ?? ''} 출발 권장`);
  }
  if (c.originNote !== undefined) lines.push(`· ${c.originNote}`);
  lines.push(...routeLines(best));
  const second = rest[0];
  if (second !== undefined) lines.push(`다른 경로: ${fmtDuration(second.totalMin)}, 환승 ${String(second.transfers)}`);
  return lines.join('\n');
}

/** "🚶 지금 나가시면 돼요 — 14:00 고객 미팅" with the next departures of the first two rides. */
export function formatDeparture(title: string, startAt: Date, route: Route, now: Date, live: boolean, timeZone: string): string {
  const rides = route.legs.filter((l) => l.mode !== 'walk').slice(0, 2);
  const day = ymdOf(startAt, timeZone) !== ymdOf(now, timeZone) ? `${dayLabel(startAt, timeZone)} ` : '';
  const lines = [`🚶 지금 나가시면 돼요 — ${day}${hhmmOf(startAt.toISOString(), timeZone) ?? ''} ${cleanText(title, 60)}`];
  for (const l of rides) {
    const next = upcomingTimes(l.next, now, timeZone);
    const when = next.length > 0 ? `다음 ${next.slice(0, 3).join(', ')}` : l.headwayMin !== undefined ? `배차 ${String(l.headwayMin)}분` : '시간표를 확인하지 못했어요';
    lines.push(`· ${legLabel(l)}${l.from !== undefined ? ` ${l.from}` : ''}: ${when}`);
  }
  if (!live) lines.push('(실시간 확인은 못 했어요. 앞서 안내한 시간 기준이에요)');
  return lines.join('\n');
}
