import { ymdOf } from '../../core/time/local-day.js';

/** "MM/DD" in the owner's zone, for notices where the month is already clear from context. */
export function shortDateOf(at: Date, timeZone: string): string {
  return ymdOf(at, timeZone).slice(5).replace('-', '/');
}
