import type { PluginContext } from '../../core/plugin/types.js';

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** Where a background dev job stands, from `dev.jobs`; undefined when it is not listed (gone or never started). */
export async function devJob(ctx: PluginContext, id: string): Promise<{ status: string; tests: 'passed' | 'failed' | 'not_run'; diffStat: string } | undefined> {
  const listed = await ctx.tools.execute('dev.jobs', {});
  const jobs = record(listed.status === 'done' ? listed.output : undefined)['jobs'];
  const job = Array.isArray(jobs) ? jobs.map(record).find((item) => item['id'] === id) : undefined;
  if (job === undefined) return undefined;
  const tests = text(job['tests']);
  return { status: text(job['status']) ?? '', tests: tests === 'passed' || tests === 'failed' ? tests : 'not_run', diffStat: text(job['diffStat']) ?? '' };
}

/** Starts the background dev job for a task; its id, or why it could not start. */
export async function startDevJob(ctx: PluginContext, repo: string, request: string): Promise<string | { failure: string }> {
  const outcome = await ctx.tools.execute('dev.start', { repo, request });
  const output = record(outcome.status === 'done' ? outcome.output : undefined);
  const jobId = text(output['jobId']);
  const status = text(output['status']);
  if (outcome.status !== 'done') return { failure: `tool_${outcome.status}` };
  return jobId !== undefined && (status === 'started' || status === 'queued' || status === 'ready') ? jobId : { failure: 'tool_failed' };
}
