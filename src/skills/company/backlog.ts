import type {
  BacklogReader,
  BacklogSnapshot,
  HealthCheck,
  HealthFinding,
} from '../../core/contracts/index.js';
import type { ReportTexts } from './locale-intake.js';
import type { CompanyLimits, CompanyTask, TaskRepository } from './types.js';
import { isOpen } from './types.js';

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const RAISE_THRESHOLD = 5;

function inWindow(iso: string | undefined, since: number): boolean {
  if (iso === undefined) return false;
  const at = Date.parse(iso);
  return Number.isFinite(at) && at >= since;
}

/** "work.backlog" capability over this plugin's tasks, for the improvement loop and doctor. */
export function backlogReader(repo: TaskRepository, limits: () => Promise<CompanyLimits>): BacklogReader {
  return {
    async snapshot(now: Date): Promise<BacklogSnapshot> {
      const current = await limits();
      const tasks = await repo.all();
      const openTasks = tasks.filter((task) => isOpen(task));
      const staleBefore = now.getTime() - (current.maxAgeHours * HOUR_MS) / 2;
      const weekStart = now.getTime() - WEEK_MS;
      const autoClosed = (task: CompanyTask): boolean =>
        task.status === 'closed' && (task.closedReason === 'stale' || task.closedReason === 'owner_wait_expired');

      return {
        open: openTasks.length,
        stale: openTasks.filter((task) => {
          const at = Date.parse(task.updatedAt);
          return Number.isFinite(at) && at < staleBefore;
        }).length,
        createdInWeek: tasks.filter((task) => inWindow(task.createdAt, weekStart)).length,
        doneInWeek: tasks.filter((task) => task.status === 'done' && inWindow(task.finishedAt, weekStart)).length,
        autoClosedInWeek: tasks.filter((task) => autoClosed(task) && inWindow(task.finishedAt, weekStart)).length,
        openLimit: current.maxOpen,
      };
    },
  };
}

/** Health check for the backlog: caps, stale work and made-vs-shipped. */
export function backlogCheck(reader: BacklogReader, texts: ReportTexts): HealthCheck {
  return {
    id: 'company.backlog',
    async run(now: Date): Promise<readonly HealthFinding[]> {
      const snapshot = await reader.snapshot(now);
      const shippingBehind =
        snapshot.createdInWeek >= RAISE_THRESHOLD && snapshot.doneInWeek * 2 < snapshot.createdInWeek;
      const ok = snapshot.open < snapshot.openLimit && snapshot.stale === 0 && !shippingBehind;
      return [{ id: 'company.backlog', area: 'backlog', ok, line: texts.backlogLine(snapshot) }];
    },
  };
}
