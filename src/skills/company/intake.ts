import { z } from 'zod';
import type { MailReader, MailSummary } from '../../core/contracts/index.js';
import type { Unsubscribe } from '../../core/events/types.js';
import type { ConversationRef, HandleResult, MessageHandler, Replier } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { Tool } from '../../core/tools/types.js';
import { checkIntake } from './limits.js';
import type { IntakeTexts } from './locale-intake.js';
import { keywordTeam, parseCompanyRequest } from './route.js';
import { recordApproval } from './store.js';
import type { CompanyConfig, CompanyLimits, CompanyTask, TaskRepository, TaskSource, TeamConfig } from './types.js';

declare module '../../core/events/types.js' {
  interface EventMap {
    /**
     * Work another plugin hands over. Without `approvedByOwner` it waits for the owner's yes like mail does; with it
     * (the owner already said "팀에 맡기기" on that plugin's card) it is queued at once.
     */
    'company.intake': { request: string; ref: string; team?: string; approvedByOwner?: true };
  }
}

/** Everything intake needs, injected so the plugin and tests wire their own parts. */
export interface IntakeDeps {
  ctx: PluginContext;
  repo: TaskRepository;
  config: CompanyConfig;
  limits: () => Promise<CompanyLimits>;
  texts: IntakeTexts;
  classify: (request: string) => Promise<TeamConfig | undefined>;
}

/** Either the stored task or the refusal text to show the owner. */
export type IntakeResult = { status: 'created'; task: CompanyTask } | { status: 'refused'; message: string };

const CHOICE = /^\(choice:\s*company\.(accept|drop):([a-f0-9]{8})\)$/;
const SEEN_KEY = 'mail:seen';
const MAX_SEEN = 500;
const MAX_PER_RUN = 5;
const MAX_TITLE = 120;

const submitInput = z.object({
  request: z.string().trim().min(1).max(2000),
  team: z.string().trim().min(1).max(40).optional(),
});

type SubmitInput = z.infer<typeof submitInput>;

function titleOf(request: string): string {
  const firstLine = request.split('\n').find((line) => line.trim() !== '');
  return (firstLine ?? request).trim().slice(0, MAX_TITLE);
}

async function classifyTeam(deps: IntakeDeps, request: string): Promise<string | undefined> {
  try {
    const team = await deps.classify(request);
    return team?.id;
  } catch (error) {
    deps.ctx.log.warn('company: classifier failed, using keywords', {
      error: error instanceof Error ? error.name : 'error',
    });
    return undefined;
  }
}

function refusalText(deps: IntakeDeps, teamId: string, reason: 'company_full' | 'team_full' | 'unknown_team', limits: CompanyLimits): string {
  if (reason === 'company_full') return deps.texts.companyFull(limits.maxOpen);
  const team = deps.config.teams.find((candidate) => candidate.id === teamId);
  if (reason === 'team_full') return deps.texts.teamFull(team?.name ?? teamId, limits.maxOpenPerTeam);
  return deps.texts.unknownTeam(deps.config.teams.map((candidate) => candidate.name));
}

/** Resolves the team, checks the caps and stores the task; refusals never throw. */
export async function submitRequest(
  deps: IntakeDeps,
  input: { request: string; source: TaskSource; sourceRef?: string; team?: string },
): Promise<IntakeResult> {
  const request = input.request.trim();
  let teamId = input.team;
  if (teamId === undefined) {
    // Mail and event text is not sent to a model just to pick a team: keywords are enough until the owner accepts.
    const classified = input.source === 'owner' ? await classifyTeam(deps, request) : undefined;
    teamId = classified ?? keywordTeam(request, deps.config.teams)?.id;
  }
  if (teamId === undefined) {
    return { status: 'refused', message: deps.texts.unknownTeam(deps.config.teams.map((team) => team.name)) };
  }

  const limits = await deps.limits();
  const open = await deps.repo.open();
  const verdict = checkIntake(open, teamId, { ...deps.config, limits });
  if (!verdict.ok) {
    return { status: 'refused', message: refusalText(deps, teamId, verdict.reason, limits) };
  }
  if (input.sourceRef !== undefined) {
    const duplicate = open.find((task) => task.sourceRef === input.sourceRef);
    if (duplicate !== undefined) {
      return { status: 'refused', message: deps.texts.duplicate(duplicate.title) };
    }
  }

  const task = await deps.repo.create({
    team: teamId,
    title: titleOf(request),
    request,
    source: input.source,
    status: input.source === 'owner' ? 'queued' : 'awaiting_accept',
    ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
  });
  return { status: 'created', task };
}

async function handleChoice(
  deps: IntakeDeps,
  action: string,
  id: string,
  replier: Replier,
  conversation: ConversationRef,
): Promise<void> {
  const task = await deps.repo.get(id);
  if (task === undefined || task.status !== 'awaiting_accept') {
    await replier.reply(conversation, { text: deps.texts.unknownTask });
    return;
  }
  if (action === 'accept') {
    const at = deps.ctx.clock.now().toISOString();
    const updated = await deps.repo.update(id, (current) => ({
      ...recordApproval(current, { approverKind: 'user', approverId: 'owner', effects: ['write'], at }),
      status: 'queued',
    }));
    if (updated !== undefined) await replier.reply(conversation, { text: deps.texts.accepted(updated) });
    return;
  }
  await deps.repo.update(id, (current) => ({ ...current, status: 'closed', closedReason: 'declined' }));
  await replier.reply(conversation, { text: deps.texts.dropped(task.title) });
}

/** Owner chat entry: the "회사:" prefix plus accept/drop buttons. */
export function intakeHandler(deps: IntakeDeps): MessageHandler {
  return {
    id: 'company.intake',
    priority: 60,
    async handle(message, replier): Promise<HandleResult> {
      if (!message.fromOwner) return 'pass';
      const choice = CHOICE.exec(message.text.trim());
      if (choice !== null) {
        await handleChoice(deps, choice[1] ?? '', choice[2] ?? '', replier, message.conversation);
        return 'handled';
      }
      const request = parseCompanyRequest(message.text, deps.config.prefix);
      if (request === undefined) return 'pass';
      const result = await submitRequest(deps, { request, source: 'owner' });
      await replier.reply(message.conversation, {
        text: result.status === 'created' ? deps.texts.accepted(result.task) : result.message,
      });
      return 'handled';
    },
  };
}

/** Tool for the assistant loop: hand over work the owner asked for. */
export function submitTool(deps: IntakeDeps): Tool<SubmitInput, IntakeResult> {
  return {
    name: 'company.submit',
    description:
      'Hand a piece of work to company mode (a team plans, does and reviews it, then reports). Only for work the owner asked for.',
    input: submitInput,
    effects: ['write'],
    async run(input) {
      return submitRequest(deps, {
        request: input.request,
        source: 'owner',
        ...(input.team !== undefined ? { team: input.team } : {}),
      });
    },
  };
}

/** Other plugins hand work over through the `company.intake` event. */
export function registerEventIntake(deps: IntakeDeps): Unsubscribe {
  return deps.ctx.bus.on('company.intake', async (payload) => {
    const result = await submitRequest(deps, {
      request: payload.request,
      source: 'event',
      sourceRef: payload.ref,
      ...(payload.team !== undefined ? { team: payload.team } : {}),
    });
    if (result.status !== 'created' || payload.approvedByOwner !== true) return;
    const at = deps.ctx.clock.now().toISOString();
    await deps.repo.update(result.task.id, (current) => ({
      ...recordApproval(current, { approverKind: 'user', approverId: 'owner', effects: ['write'], at }),
      status: 'queued',
    }));
  });
}

function readSeen(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

async function runMailIntake(deps: IntakeDeps, mail: () => MailReader | undefined, query: string): Promise<void> {
  const reader = mail();
  if (reader === undefined) return;
  let found: MailSummary[];
  try {
    found = await reader.search({ text: query, limit: MAX_PER_RUN });
  } catch (error) {
    deps.ctx.log.warn('company: mail search failed', { error: error instanceof Error ? error.name : 'error' });
    return;
  }

  const newest = [...found].sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime()).slice(0, MAX_PER_RUN);
  const stored = await deps.ctx.kv.get<unknown>(SEEN_KEY);
  // First run only measures the mailbox: a fresh install must not turn a mailbox into tasks.
  const firstRun = stored === undefined || !Array.isArray(stored);
  const known = new Set(readSeen(stored));
  const nextSeen = [...known];
  for (const summary of newest) {
    if (known.has(summary.id)) continue;
    known.add(summary.id);
    nextSeen.push(summary.id);
    if (firstRun) continue;
    await submitRequest(deps, {
      request: `${summary.subject}\n${summary.snippet}`,
      source: 'mail',
      sourceRef: `mail:${summary.id}`,
    });
  }
  await deps.ctx.kv.set(SEEN_KEY, nextSeen.slice(-MAX_SEEN));
}

/** New mail becomes awaiting-accept work; the first run only seeds the seen list. */
export function registerMailIntake(deps: IntakeDeps, mail: () => MailReader | undefined): void {
  const intake = deps.config.mailIntake;
  if (!intake.enabled || intake.query.trim() === '') return;
  deps.ctx.scheduler.add({
    name: 'company.mail-intake',
    schedule: { kind: 'every', seconds: intake.everyMinutes * 60 },
    run: () => runMailIntake(deps, mail, intake.query),
  });
}
