import { zonedIso } from '../../core/time/date-spec.js';

const PRINTED = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d))?$/;

export interface PrintedTime {
  ymd: string;
  /** Undefined for a date-only booking. */
  hhmm?: string;
}

/** Parses the printed local form "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM". Rejects impossible calendar dates. */
export function parsePrinted(value: string): PrintedTime | undefined {
  const match = PRINTED.exec(value.trim());
  if (match === null) return undefined;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return undefined;
  const ymd = `${match[1]}-${match[2]}-${match[3]}`;
  const hh = match[4];
  const mm = match[5];
  if (hh === undefined || mm === undefined) return { ymd };
  return { ymd, hhmm: `${hh}:${mm}` };
}

/** Owner-zone instant for a printed local time; a date-only value starts at local midnight. */
export function toInstant(printed: PrintedTime, timeZone: string): string {
  return zonedIso(printed.ymd, printed.hhmm ?? '00:00', timeZone);
}
