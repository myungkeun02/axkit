import type { Choice } from '../../core/conversation/types.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { dayRange, ymdOf } from '../../core/time/local-day.js';
import type { ReportTexts } from './locale-intake.js';
import type { CompanyConfig, CompanyTask, TaskRepository, TeamConfig } from './types.js';
import { FINAL_STATUSES, isOpen } from './types.js';

const MAX_TEAM_LINES = 6;
const MAX_CHOICES = 5;
const MAX_CHOICE_TITLE = 20;

function finishedOn(task: CompanyTask, from: Date, to: Date): boolean {
  if (!FINAL_STATUSES.includes(task.status) || task.finishedAt === undefined) return false;
  const at = Date.parse(task.finishedAt);
  return Number.isFinite(at) && at >= from.getTime() && at < to.getTime();
}

function countsOf(
  finished: readonly CompanyTask[],
  open: readonly CompanyTask[],
): { done: number; failed: number; closed: number; open: number } {
  return {
    done: finished.filter((task) => task.status === 'done').length,
    failed: finished.filter((task) => task.status === 'failed').length,
    closed: finished.filter((task) => task.status === 'closed').length,
    open: open.length,
  };
}

function taskLine(task: CompanyTask, texts: ReportTexts): string {
  const reason =
    task.status === 'closed' && task.closedReason !== undefined
      ? ` (${texts.closeReasonLabel(task.closedReason)})`
      : '';
  return `• ${texts.statusLabel(task.status)}${reason} ${task.title}`;
}

function clipTitle(title: string, max: number): string {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

function choicesOf(open: readonly CompanyTask[], texts: ReportTexts): Choice[] {
  const choices: Choice[] = [];
  const awaiting = open.filter((task) => task.status === 'awaiting_accept').slice(0, MAX_CHOICES);
  for (const task of awaiting) {
    const title = clipTitle(task.title, MAX_CHOICE_TITLE);
    choices.push({ id: `company.accept:${task.id}`, label: texts.acceptLabel(title) });
    choices.push({ id: `company.drop:${task.id}`, label: texts.dropLabel(title) });
  }
  return choices;
}

/** The one daily company message: what finished today and what is still open. */
export function buildReport(input: {
  tasks: readonly CompanyTask[];
  teams: readonly TeamConfig[];
  now: Date;
  timeZone: string;
  texts: ReportTexts;
}): { text: string; choices: Choice[] } | undefined {
  const { tasks, teams, now, timeZone, texts } = input;
  const ymd = ymdOf(now, timeZone);
  const range = dayRange(ymd, timeZone);
  const finished = tasks.filter((task) => finishedOn(task, range.from, range.to));
  const open = tasks.filter((task) => isOpen(task));
  if (finished.length === 0 && open.length === 0) return undefined;

  const visible = [...open, ...finished];
  const lines = [texts.title(ymd, countsOf(finished, open))];
  for (const team of teams) {
    const inTeam = visible.filter((task) => task.team === team.id);
    if (inTeam.length === 0) continue;
    lines.push(`**${team.name}**`);
    for (const task of inTeam.slice(0, MAX_TEAM_LINES)) lines.push(taskLine(task, texts));
    if (inTeam.length > MAX_TEAM_LINES) lines.push(`… +${inTeam.length - MAX_TEAM_LINES}`);
  }
  return { text: lines.join('\n'), choices: choicesOf(open, texts) };
}

/** Daily job: reaps first, then sends at most one notice. */
export function registerReport(
  ctx: PluginContext,
  repo: TaskRepository,
  config: CompanyConfig,
  texts: ReportTexts,
  reap: () => Promise<CompanyTask[]>,
): void {
  ctx.scheduler.add({
    name: 'company.report',
    // Config validation already guarantees HH:MM.
    schedule: { kind: 'daily', at: config.reportAt as `${number}:${number}` },
    async run(now) {
      await reap();
      const report = buildReport({
        tasks: await repo.all(),
        teams: config.teams,
        now,
        timeZone: ctx.assistant.timezone,
        texts,
      });
      if (report === undefined) return;
      const notifier = ctx.tryUse(Contracts.notifier);
      if (notifier === undefined) {
        ctx.log.warn('company: no notifier, daily report skipped');
        return;
      }
      await notifier.notify({
        kind: 'company.report',
        dedupeKey: ymdOf(now, ctx.assistant.timezone),
        text: report.text,
        choices: report.choices,
      });
    },
  });
}
