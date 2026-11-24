import { Contracts } from '../../../core/contracts/index.js';
import type { AppView } from '../../../core/contracts/device-api.js';
import { ViewInputError, ownerInputError } from '../../../core/contracts/device-api.js';
import type { PluginContext } from '../../../core/plugin/types.js';
import type { JobStatus, Schedule } from '../../../core/scheduler/types.js';
import { pauseCovering } from '../../../core/switches/covering.js';
import { z } from 'zod';
import { jobLabel } from './job-labels.js';

/** Pauses need an end (core.switches); an owner's "off" lasts the longest allowed and the screen says until when. */
const OFF_DAYS = 30;
const toggleSchema = z.object({ id: z.string().min(1).max(120), enabled: z.boolean() });

/** Interval label in the owner's language: "5분마다" / "every 5 min". */
export function scheduleLabel(schedule: Schedule, language: string): string {
  const en = language === 'en';
  if (schedule.kind === 'daily') return en ? `daily ${schedule.at}` : `매일 ${schedule.at}`;
  const s = schedule.seconds;
  if (s % 86_400 === 0) return en ? `every ${s / 86_400} d` : `${s / 86_400}일마다`;
  if (s % 3_600 === 0) return en ? `every ${s / 3_600} h` : `${s / 3_600}시간마다`;
  if (s % 60 === 0) return en ? `every ${s / 60} min` : `${s / 60}분마다`;
  return en ? `every ${s} s` : `${s}초마다`;
}

function scheduleOf(schedule: Schedule, timezone: string) {
  return schedule.kind === 'every'
    ? { kind: 'interval', everySec: schedule.seconds }
    : { kind: 'daily', at: schedule.at, timezone };
}

/** Every repeating job of the core scheduler, with its last run (docs/APP-PROTOCOL.md §7.8), and `toggle` (R6). */
export function jobsView(ctx: PluginContext): AppView {
  return {
    name: 'jobs',
    version: 1,
    async read() {
      const list: JobStatus[] = (await ctx.scheduler.list?.()) ?? [];
      const pauses = (await ctx.tryUse(Contracts.switches)?.list().catch(() => [])) ?? [];
      const language = ctx.assistant.language;
      const en = language === 'en';
      const jobs = list
        .map((job) => {
          const pause = pauseCovering(job.name, pauses);
          return {
            id: job.name,
            name: job.label ?? jobLabel(job.name, language) ?? job.name,
            ...(pause !== undefined
              ? { detail: en ? `Paused until ${pause.until}: ${pause.reason}` : `${pause.until}까지 멈춤: ${pause.reason}` }
              : {}),
            schedule: scheduleOf(job.schedule, ctx.assistant.timezone),
            scheduleLabel: scheduleLabel(job.schedule, language),
            enabled: pause === undefined,
            running: job.running,
            lastRun: job.lastRun ?? null,
            nextRunAt: pause === undefined ? (job.nextRunAt?.toISOString() ?? null) : null,
            source: 'ax',
            // a breaker or a whole-plugin pause is lifted in chat, not by one job's switch
            ...(pause !== undefined && pause.feature !== job.name ? { toggleable: false } : {}),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      const groups = [
        { id: 'ax', label: en ? 'Scheduled jobs' : '반복 작업', jobs: jobs.filter((job) => job.enabled) },
        { id: 'off', label: en ? 'Paused' : '꺼진 작업', jobs: jobs.filter((job) => !job.enabled) },
      ].filter((group) => group.id === 'ax' || group.jobs.length > 0);
      return { generatedAt: ctx.clock.now().toISOString(), groups };
    },
    actions: {
      async toggle(body) {
        const parsed = toggleSchema.safeParse(body);
        if (!parsed.success) throw new ViewInputError('toggle needs {id, enabled}');
        const { id, enabled } = parsed.data;
        const en = ctx.assistant.language === 'en';
        const known = ((await ctx.scheduler.list?.()) ?? []).some((job) => job.name === id);
        if (!known) throw ownerInputError(en ? 'No such job' : '그런 반복 작업이 없어요');
        const switches = ctx.tryUse(Contracts.switches);
        if (switches === undefined) throw ownerInputError(en ? 'Jobs cannot be switched here' : '여기서는 끄고 켤 수 없어요');
        const covering = pauseCovering(id, await switches.list());
        if (enabled) {
          if (covering !== undefined && covering.feature !== id) {
            throw ownerInputError(en ? `Turned off together with "${covering.feature}": ${covering.reason}` : `"${covering.feature}"와 함께 꺼져 있어요: ${covering.reason}`);
          }
          if (covering !== undefined) await switches.resume(id);
        } else if (covering === undefined) {
          await switches.pause(id, {
            reason: en ? 'Turned off in the app' : '앱에서 껐어요',
            until: new Date(ctx.clock.now().getTime() + OFF_DAYS * 86_400_000),
            by: { kind: 'user', id: 'owner' },
          });
        }
        return { id, enabled };
      },
    },
  };
}
