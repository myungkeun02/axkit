import type { WeatherReport } from '../../core/contracts/index.js';
import type { SegmentKind } from './types.js';

export type TripLanguage = 'ko' | 'en';

export interface TripTexts {
  readonly language: TripLanguage;
  readonly mailQuery: string;
  readonly kindLabels: Readonly<Record<SegmentKind, string>>;
  readonly untitledTrip: string;
  dateRange(startYmd: string, endYmd: string): string;
  header(days: number, name: string, dates: string): string;
  tripTitle(name: string, dates: string): string;
  readonly checklistTitle: string;
  readonly baseChecklist: readonly string[];
  flightChecklist(international: boolean): readonly string[];
  readonly trainChecklist: string;
  readonly stayChecklist: string;
  readonly carChecklist: string;
  readonly eventChecklist: string;
  weatherLine(place: string, report: WeatherReport): string;
  referenceLine(title: string, reference: string): string;
  readonly noTrips: string;
  addSegmentLabel(kind: string, title: string, start: string): string;
  removeSegmentLabel(title: string): string;
  readonly cancelApplied: string;
}

function monthDay(ymd: string): string {
  return `${ymd.slice(5, 7)}/${ymd.slice(8, 10)}`;
}

function range(startYmd: string, endYmd: string, separator: string): string {
  if (startYmd === endYmd) return monthDay(startYmd);
  return `${monthDay(startYmd)}${separator}${monthDay(endYmd)}`;
}

function temperature(report: WeatherReport): string | undefined {
  if (report.tempC !== undefined) return `${report.tempC}°C`;
  if (report.minC !== undefined && report.maxC !== undefined) return `${report.minC}~${report.maxC}°C`;
  if (report.minC !== undefined) return `${report.minC}°C`;
  return undefined;
}

function weatherText(place: string, report: WeatherReport, language: TripLanguage): string {
  const parts = [report.sky, temperature(report)];
  if (report.rainChance !== undefined) {
    parts.push(language === 'ko' ? `강수 ${report.rainChance}%` : `${report.rainChance}% rain`);
  }
  const body = parts.filter((part): part is string => part !== undefined && part !== '').join(', ');
  return language === 'ko' ? `${place} 날씨: ${body}` : `${place} weather: ${body}`;
}

const KO: TripTexts = {
  language: 'ko',
  mailQuery:
    '예약 확인 OR 예약번호 OR 탑승권 OR 항공권 OR e-티켓 OR 승차권 OR 숙소 OR 렌터카 OR 체크인',
  kindLabels: {
    flight: '항공',
    train: '기차',
    bus: '버스',
    stay: '숙소',
    car: '렌터카',
    event: '행사',
    other: '예약',
  },
  untitledTrip: '여행',
  dateRange: (start, end) => range(start, end, '~'),
  header: (days, name, dates) => `D-${days} ${name} (${dates})`,
  tripTitle: (name, dates) => `${name} (${dates})`,
  checklistTitle: '준비물',
  baseChecklist: ['신분증', '충전기', '예약 내역 확인'],
  flightChecklist: (international) =>
    international
      ? ['여권 챙기기 (유효기간 확인)', '온라인 체크인 하기', '공항 도착: 국제선은 출발 2~3시간 전']
      : ['신분증 챙기기', '온라인 체크인 하기', '공항 도착: 국내선은 출발 1시간 전'],
  trainChecklist: '출발역·터미널과 시간 확인',
  stayChecklist: '숙소 체크인 시간과 주소 확인',
  carChecklist: '운전면허증 챙기기',
  eventChecklist: '입장권 준비',
  weatherLine: (place, report) => weatherText(place, report, 'ko'),
  referenceLine: (title, reference) => `- ${title}: 예약번호 ${reference}`,
  noTrips: '등록된 여행 일정이 없어요. 예약 확인 메일이 오면 자동으로 찾아둘게요.',
  addSegmentLabel: (kind, title, start) => `여행 일정 추가: ${kind} ${title} (${start})`,
  removeSegmentLabel: (title) => `여행 일정 삭제: ${title}`,
  cancelApplied: '예약 취소를 반영했어요. 취소된 예약을 일정에서 뺐어요.',
};

const EN: TripTexts = {
  language: 'en',
  mailQuery:
    'booking confirmation OR reservation confirmed OR itinerary OR e-ticket OR boarding pass OR confirmation number',
  kindLabels: {
    flight: 'Flight',
    train: 'Train',
    bus: 'Bus',
    stay: 'Stay',
    car: 'Car',
    event: 'Event',
    other: 'Booking',
  },
  untitledTrip: 'Trip',
  dateRange: (start, end) => range(start, end, '–'),
  header: (days, name, dates) => `D-${days} ${name} (${dates})`,
  tripTitle: (name, dates) => `${name} (${dates})`,
  checklistTitle: 'Checklist',
  baseChecklist: ['ID card', 'Charger', 'Booking details checked'],
  flightChecklist: (international) =>
    international
      ? ['Passport (check validity)', 'Online check-in', 'Airport: arrive 2-3 hours before an international flight']
      : ['ID card', 'Online check-in', 'Airport: arrive 1 hour before a domestic flight'],
  trainChecklist: 'Departure station or terminal and time',
  stayChecklist: 'Stay check-in time and address',
  carChecklist: 'Driver license',
  eventChecklist: 'Ticket ready',
  weatherLine: (place, report) => weatherText(place, report, 'en'),
  referenceLine: (title, reference) => `- ${title}: booking reference ${reference}`,
  noTrips: 'No trip is registered yet. When a booking confirmation mail arrives, I will find it.',
  addSegmentLabel: (kind, title, start) => `Add trip segment: ${kind} ${title} (${start})`,
  removeSegmentLabel: (title) => `Remove trip segment: ${title}`,
  cancelApplied: 'I applied the cancellation and removed the cancelled booking.',
};

export function tripTexts(language: string): TripTexts {
  return language === 'en' ? EN : KO;
}
