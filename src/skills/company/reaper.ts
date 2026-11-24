import type { CompanyLimits, CompanyTask, TaskRepository } from './types.js';

const HOUR_MS = 3_600_000;

/**
 * The original assistant left 101 of 104 running tasks untouched for over a day and 129 undecided
 * decisions, 115 older than a week. Age closes them here instead of letting them pile up forever.
 */
export async function reapTasks(repo: TaskRepository, limits: CompanyLimits, now: Date): Promise<CompanyTask[]> {
  const open = await repo.open();
  const closed: CompanyTask[] = [];
  for (const task of open) {
    const updatedAt = Date.parse(task.updatedAt);
    if (!Number.isFinite(updatedAt)) continue;
    const age = now.getTime() - updatedAt;
    if (age < 0) continue;

    const waiting = task.status === 'awaiting_owner' || task.status === 'awaiting_accept';
    const limitMs = waiting ? limits.ownerWaitDays * 24 * HOUR_MS : limits.maxAgeHours * HOUR_MS;
    if (age <= limitMs) continue;

    const reason = waiting ? 'owner_wait_expired' : 'stale';
    const updated = await repo.update(task.id, (current) => ({ ...current, status: 'closed', closedReason: reason }));
    if (updated !== undefined) closed.push(updated);
  }
  return closed;
}
