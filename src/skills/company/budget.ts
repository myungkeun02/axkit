import type { UsageReader } from '../../core/contracts/usage.js';
import { dayRange, ymdOf } from '../../core/time/local-day.js';

const PURPOSE_PREFIX = 'company.';

/** Company mode's own spend for the owner's current day; it never counts the assistant's calls. */
export async function companySpentToday(
  usage: UsageReader | undefined,
  now: Date,
  timeZone: string,
): Promise<number> {
  if (usage === undefined) return 0;
  const { from } = dayRange(ymdOf(now, timeZone), timeZone);
  const purposes = await usage.byPurpose(from, PURPOSE_PREFIX);
  return purposes.reduce((total, item) => total + item.costUsd, 0);
}

/** dailyUsd 0 means "no model work at all"; work waits rather than failing. */
export async function overCompanyBudget(
  usage: UsageReader | undefined,
  now: Date,
  timeZone: string,
  dailyUsd: number,
): Promise<boolean> {
  if (dailyUsd <= 0) return true;
  return (await companySpentToday(usage, now, timeZone)) >= dailyUsd;
}
