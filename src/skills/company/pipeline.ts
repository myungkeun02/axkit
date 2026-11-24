import { Contracts } from '../../core/contracts/index.js';
import type { DocStore } from '../../core/contracts/docs.js';
import { LlmError } from '../../core/llm/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { ymdOf } from '../../core/time/local-day.js';
import { overCompanyBudget } from './budget.js';
import { devJob, startDevJob } from './dev-job.js';
import { planTask, reviewTask, runStep } from './llm.js';
import type { WorkTexts } from './locale-work.js';
import { recordApproval } from './store.js';
import { logChange, logDecision, teamContext } from './team-docs.js';
import type { CompanyConfig, CompanyLimits, CompanyTask, TaskRepository, TeamConfig } from './types.js';

const FEATURE = 'skill.company';
const MAX_RESULT = 4000;
const MAX_DEV_REQUEST = 2000;
const MAX_PREVIEW = 300;
const MAX_LOG_TEXT = 1000;

export type TickResult = 'idle' | 'paused' | 'over_budget' | 'advanced' | 'failed';

export interface PipelineDeps {
  ctx: PluginContext;
  repo: TaskRepository;
  config: CompanyConfig;
  limits: () => Promise<CompanyLimits>;
  texts: WorkTexts;
}

class AdvanceFailure extends Error {
  constructor(readonly signature: string) {
    super(signature);
    this.name = 'AdvanceFailure';
  }
}

function outputOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function textOf(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] : undefined;
}

function joinedOutputs(task: CompanyTask): string {
  return task.steps.map((step) => step.output ?? '').filter((output) => output.trim() !== '').join('\n\n');
}

function signatureOf(error: unknown): string {
  if (error instanceof AdvanceFailure) return error.signature;
  if (error instanceof LlmError) return `llm_${error.code}`;
  if (error instanceof Error && error.message === 'parse') return 'parse';
  return 'error';
}

/** Review first, then running, then queued; oldest first inside a status. One tick advances one task. */
function rank(status: CompanyTask['status']): number {
  if (status === 'review') return 0;
  if (status === 'running') return 1;
  if (status === 'queued') return 2;
  return 3;
}

/** Lead plans, members do, lead reviews, one report line; the turn never sends, pays, deletes or releases. */
export class CompanyPipeline {
  private running = false;
  private budgetLoggedFor: string | undefined;

  constructor(private readonly deps: PipelineDeps) {}

  async tick(now: Date): Promise<TickResult> {
    if (this.running) return 'idle';
    this.running = true;
    try {
      if (await this.isPaused()) return 'paused';
      if (await this.isOverBudget(now)) return 'over_budget';
      const task = await this.pick();
      if (task === undefined) return 'idle';
      await this.advance(task, now);
      await this.health();
      return 'advanced';
    } catch (error) {
      await this.health(signatureOf(error));
      return 'failed';
    } finally {
      this.running = false;
    }
  }

  private async isPaused(): Promise<boolean> {
    const switches = this.deps.ctx.tryUse(Contracts.switches);
    return switches !== undefined && (await switches.pausedState(FEATURE)) !== undefined;
  }

  private async isOverBudget(now: Date): Promise<boolean> {
    const usage = this.deps.ctx.tryUse(Contracts.usage);
    const zone = this.deps.ctx.assistant.timezone;
    if (!(await overCompanyBudget(usage, now, zone, this.deps.config.dailyUsd))) return false;
    const day = ymdOf(now, zone);
    if (this.budgetLoggedFor !== day) {
      this.budgetLoggedFor = day;
      this.deps.ctx.log.info('company: daily budget reached, tasks wait');
    }
    return true;
  }

  private async pick(): Promise<CompanyTask | undefined> {
    const open = await this.deps.repo.open();
    const candidates = open.filter((task) => rank(task.status) < 3);
    return candidates.sort(
      (left, right) => rank(left.status) - rank(right.status) || left.createdAt.localeCompare(right.createdAt),
    )[0];
  }

  private async advance(task: CompanyTask, now: Date): Promise<void> {
    if (task.status === 'queued') await this.plan(task, now);
    else if (task.status === 'running') await this.work(task);
    else if (task.status === 'review') await this.review(task, now);
  }

  private async teamOf(task: CompanyTask): Promise<TeamConfig> {
    const team = this.deps.config.teams.find((candidate) => candidate.id === task.team);
    if (team !== undefined) return team;
    await this.update(task, (current) => ({ ...current, status: 'failed', closedReason: 'failed' }));
    throw new AdvanceFailure('error');
  }

  private async update(task: CompanyTask, change: (current: CompanyTask) => CompanyTask): Promise<CompanyTask> {
    const updated = await this.deps.repo.update(task.id, change);
    if (updated === undefined) throw new AdvanceFailure('error');
    return updated;
  }

  private docs(): DocStore | undefined {
    return this.deps.ctx.tryUse(Contracts.docs);
  }

  private async contextOf(team: TeamConfig): Promise<string> {
    const docs = this.docs();
    return docs === undefined ? team.role : teamContext(docs, team.id);
  }

  private async log(team: TeamConfig, text: string, author: { kind: 'agent' | 'policy'; id: string }, task: CompanyTask): Promise<void> {
    const docs = this.docs();
    if (docs !== undefined) await logDecision(docs, team.id, text.slice(0, MAX_LOG_TEXT), author, [`task:${task.id}`]);
  }

  private async plan(task: CompanyTask, now: Date): Promise<void> {
    const team = await this.teamOf(task);
    const plan = await planTask(
      this.deps.ctx.llm,
      team,
      task,
      await this.contextOf(team),
      (await this.deps.limits()).maxSteps,
      this.deps.texts.language,
    );
    await this.update(task, (current) =>
      recordApproval(
        {
          ...current,
          status: 'running',
          title: plan.title,
          steps: plan.steps.map((text) => ({ text })),
          ownerEffects: plan.ownerEffects,
        },
        { approverKind: 'agent', approverId: `lead:${team.id}`, effects: ['write'], at: now.toISOString() },
      ),
    );
    await this.log(team, `${plan.title}: ${plan.steps.join(' · ')}`, { kind: 'agent', id: `lead:${team.id}` }, task);
  }

  private async work(task: CompanyTask): Promise<void> {
    const team = await this.teamOf(task);
    if (team.kind === 'dev') {
      await this.devStart(task, team);
      return;
    }
    const index = task.steps.findIndex((step) => step.output === undefined);
    if (index < 0) {
      await this.update(task, (current) => ({ ...current, status: 'review' }));
      return;
    }
    const output = await runStep(this.deps.ctx.llm, team, task, index, await this.contextOf(team), this.deps.texts.language);
    await this.update(task, (current) => {
      const steps = current.steps.map((step, position) => (position === index ? { ...step, output } : step));
      const complete = steps.every((step) => step.output !== undefined);
      return { ...current, steps, ...(complete ? { status: 'review' as const } : {}) };
    });
  }

  /** A dev task: the first tick starts the background job, later ticks follow it (dev.jobs) until ready or failed. */
  private async devStart(task: CompanyTask, team: TeamConfig): Promise<void> {
    const registered = this.deps.ctx.tools.list().some((info) => info.name === 'dev.start');
    if (!registered || team.repo === undefined) {
      await this.fail(task, this.deps.texts.devMissing);
      throw new AdvanceFailure('error');
    }
    if (task.devJobId === undefined) {
      const started = await startDevJob(this.deps.ctx, team.repo, [task.title, ...task.steps.map((step) => `- ${step.text}`)].join('\n').slice(0, MAX_DEV_REQUEST));
      if (typeof started !== 'string') {
        await this.fail(task);
        throw new AdvanceFailure(started.failure);
      }
      await this.update(task, (current) => ({ ...current, devJobId: started }));
      return;
    }
    const job = await devJob(this.deps.ctx, task.devJobId);
    if (job?.status === 'queued' || job?.status === 'running') return;
    if (job?.status !== 'ready') {
      await this.fail(task);
      throw new AdvanceFailure('tool_failed');
    }
    const line = `${job.diffStat}\n${this.deps.texts.testsLine(job.tests)}`.trim();
    await this.update(task, (current) => ({
      ...current,
      status: 'review',
      steps: current.steps.map((step, position) => (position === 0 ? { ...step, output: line } : step)),
    }));
  }

  private async review(task: CompanyTask, now: Date): Promise<void> {
    const team = await this.teamOf(task);
    const result = await reviewTask(
      this.deps.ctx.llm,
      team,
      task,
      await this.contextOf(team),
      this.deps.texts.language,
    );
    if (result.verdict === 'revise') return this.revise(task, team, result.note);
    if (team.kind === 'dev') return this.openPr(task, team, now);
    if (task.ownerEffects.length > 0) return this.awaitOwner(task);
    return this.finish(task, team);
  }

  private async revise(task: CompanyTask, team: TeamConfig, note: string): Promise<void> {
    if (task.revisions >= (await this.deps.limits()).maxRevisions) {
      await this.update(task, (current) => ({
        ...current,
        status: 'failed',
        closedReason: 'review_failed',
        reviewNote: note,
      }));
      // A failed review is an outcome, not a broken feature: it must not count toward the breaker.
      await this.log(team, `${task.title}: ${this.deps.texts.reviewFailed}`, { kind: 'agent', id: `lead:${team.id}` }, task);
      return;
    }
    await this.update(task, (current) => ({
      ...current,
      status: 'running',
      revisions: current.revisions + 1,
      reviewNote: note,
      steps: current.steps.map((step) => ({ text: step.text })),
    }));
  }

  private async openPr(task: CompanyTask, team: TeamConfig, now: Date): Promise<void> {
    if (task.devJobId === undefined) {
      await this.fail(task);
      throw new AdvanceFailure('tool_failed');
    }
    const outcome = await this.deps.ctx.tools.execute('dev.open_pr', { jobId: task.devJobId });
    if (outcome.status === 'denied' || outcome.status === 'expired') {
      await this.update(task, (current) => ({ ...current, status: 'closed', closedReason: 'declined' }));
      return;
    }
    if (outcome.status !== 'done') {
      await this.fail(task);
      throw new AdvanceFailure(`tool_${outcome.status}`);
    }
    const output = outputOf(outcome.output);
    const url = textOf(output, 'url');
    if (textOf(output, 'status') !== 'opened' || url === undefined) {
      await this.fail(task);
      throw new AdvanceFailure('tool_failed');
    }
    await this.update(task, (current) =>
      recordApproval(
        { ...current, status: 'done', result: url },
        { approverKind: 'user', approverId: 'owner', effects: ['send'], at: now.toISOString(), note: url },
      ),
    );
    await this.change(team, task, url);
  }

  private async awaitOwner(task: CompanyTask): Promise<void> {
    const result = joinedOutputs(task).slice(0, MAX_RESULT);
    await this.update(task, (current) => ({ ...current, status: 'awaiting_owner', result }));
    const notifier = this.deps.ctx.tryUse(Contracts.notifier);
    if (notifier === undefined) return;
    const effects = task.ownerEffects.map((effect) => this.deps.texts.effectLabel(effect)).join(', ');
    await notifier.notify({
      kind: 'company.decision',
      dedupeKey: task.id,
      text: this.deps.texts.decisionNotice(task.title, effects, result.slice(0, MAX_PREVIEW)),
      choices: [
        { id: `company.approve:${task.id}`, label: this.deps.texts.approveChoice(task.title) },
        { id: `company.decline:${task.id}`, label: this.deps.texts.declineChoice(task.title) },
      ],
    });
  }

  private async finish(task: CompanyTask, team: TeamConfig): Promise<void> {
    const result = joinedOutputs(task).slice(0, MAX_RESULT);
    await this.update(task, (current) => ({ ...current, status: 'done', result }));
    await this.change(team, task, result);
  }

  private async change(team: TeamConfig, task: CompanyTask, result: string): Promise<void> {
    const docs = this.docs();
    if (docs === undefined) return;
    const firstLine = result.trim().split('\n')[0]?.trim() ?? '';
    await logChange(docs, team.id, `${task.title}: ${firstLine}`.slice(0, MAX_LOG_TEXT), { kind: 'agent', id: `member:${team.id}` }, [`task:${task.id}`]);
  }

  private async fail(task: CompanyTask, result?: string): Promise<void> {
    await this.update(task, (current) => ({
      ...current,
      status: 'failed',
      closedReason: 'failed',
      ...(result !== undefined ? { result } : {}),
    }));
  }

  private async health(signature?: string): Promise<void> {
    const health = this.deps.ctx.tryUse(Contracts.featureHealth);
    if (health === undefined) return;
    try {
      if (signature === undefined) await health.recordSuccess(FEATURE);
      else await health.recordFailure({ feature: FEATURE, signature });
    } catch {
      this.deps.ctx.log.warn('company: health record failed');
    }
  }
}
