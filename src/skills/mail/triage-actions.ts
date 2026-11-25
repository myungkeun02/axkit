import type { MailMessage } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ConfirmChoice } from '../../core/policy/types.js';
import { TOPIC } from '../../core/policy/topics.js';
import type { QuestionRequest } from '../../core/policy/questions.js';
import type { ToolCallContext } from '../../core/tools/types.js';
import type { EventSuggestion, ReplySuggestion, Suggestion, TodoSuggestion } from './triage-model.js';
import { mailGrounding } from './triage-model.js';
import type { TriageTexts } from './triage-locale.js';
import { senderName } from './triage-locale.js';

export const ASKED_BY = 'skill.mail';
const MAX_CARD_BODY = 1_500;
/** Company mode's tool; when it is loaded a to-do card also offers to hand the work to a team. */
const TEAM_TOOL = 'company.submit';

/** Each suggestion runs as a real tool call; a missing tool means that kind of action is simply not offered. */
const TOOL_FOR: Record<Suggestion['kind'], string> = {
  reply: 'mail.draft_reply',
  event: 'calendar.add_event',
  todo: 'todo.add',
};

/** R15: one topic per mail and kind, so the same mail is never asked about twice. */
export function suggestionTopic(kind: Suggestion['kind'], messageId: string): string {
  return `mail:${kind}:${messageId}`;
}

function choices(yes: string, texts: TriageTexts): ConfirmChoice[] {
  return [
    { id: 'yes', label: yes, tone: 'primary', means: 'approved' },
    { id: 'later', label: texts.later, means: 'later' },
    { id: 'no', label: texts.no, tone: 'danger', means: 'denied' },
  ];
}

function withTeam(list: ConfirmChoice[], texts: TriageTexts): ConfirmChoice[] {
  const [first, ...rest] = list;
  const team: ConfirmChoice = { id: 'team', label: texts.teamYes, detail: texts.teamDetail, means: 'approved' };
  return first === undefined ? [team, ...rest] : [first, team, ...rest];
}

function subjectOf(message: MailMessage, texts: TriageTexts): string {
  return message.subject === '' ? texts.noSubject : message.subject;
}

function question(action: Suggestion, message: MailMessage, texts: TriageTexts, offer: { teams: boolean; todo: boolean }): QuestionRequest {
  const who = senderName(message.from);
  const subject = subjectOf(message, texts);
  const base = { topic: suggestionTopic(action.kind, message.id), askedBy: ASKED_BY, effects: ['write'] as const };
  switch (action.kind) {
    case 'reply':
      return {
        ...base,
        summary: texts.replyQuestion(who),
        note: texts.replyNote(subject, action.body.slice(0, MAX_CARD_BODY)),
        choices: choices(texts.replyYes, texts),
      };
    case 'event':
      return {
        ...base,
        summary: texts.eventQuestion(action.title),
        note: texts.fromNote(who, subject, action.evidence),
        choices: choices(texts.eventYes, texts),
      };
    case 'todo':
      return {
        ...base,
        summary: texts.todoQuestion(action.text),
        note: texts.fromNote(who, subject, action.evidence),
        choices: !offer.todo
          ? choices(texts.teamYes, texts)
          : offer.teams
            ? withTeam(choices(texts.todoYes, texts), texts)
            : choices(texts.todoYes, texts),
      };
  }
}

async function tell(ctx: PluginContext, text: string, dedupeKey: string): Promise<void> {
  await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'mail.triage', text, dedupeKey }).catch(() => undefined);
}

function draftOf(output: unknown): { draftId: string; to: string[]; cc: string[]; subject: string; body: string; attachments?: string[] } | undefined {
  if (typeof output !== 'object' || output === null) return undefined;
  const record = output as Record<string, unknown>;
  const list = (value: unknown): string[] | undefined =>
    Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
  const to = list(record.to);
  const cc = list(record.cc) ?? [];
  if (typeof record.draftId !== 'string' || to === undefined || to.length === 0) return undefined;
  if (typeof record.subject !== 'string' || typeof record.body !== 'string') return undefined;
  const attachments = list(record.attachments);
  return { draftId: record.draftId, to, cc, subject: record.subject, body: record.body, ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}) };
}

async function reply(ctx: PluginContext, action: ReplySuggestion, message: MailMessage, texts: TriageTexts, call: ToolCallContext): Promise<void> {
  const drafted = await ctx.tools.execute('mail.draft_reply', { messageId: message.id, body: action.body }, call);
  if (drafted.status !== 'done') {
    ctx.log.warn('mail triage: reply draft did not run', { status: drafted.status });
    return;
  }
  await sendDrafted(ctx, drafted.output, message, texts, call);
}

/** The send card for a draft that exists: "send" always needs the owner's yes, whatever the config says. */
export async function sendDrafted(ctx: PluginContext, output: unknown, message: MailMessage, texts: TriageTexts, call: ToolCallContext): Promise<void> {
  const draft = draftOf(output);
  if (draft === undefined) {
    ctx.log.warn('mail triage: the draft came back without its recipients');
    return;
  }
  const sent = await ctx.tools.execute('mail.send_draft', draft, call);
  if (sent.status === 'done') await tell(ctx, texts.sent(senderName(message.from)), `sent:${message.id}`);
  else await tell(ctx, texts.draftKept, `kept:${message.id}`);
}

async function event(ctx: PluginContext, action: EventSuggestion, message: MailMessage, texts: TriageTexts, call: ToolCallContext): Promise<void> {
  const input = {
    title: action.title,
    date: action.date,
    evidence: action.evidence,
    ...(action.time !== undefined ? { time: action.time } : {}),
  };
  // A guessed date (no year, AM/PM unsaid) makes the executor ask again on its own card.
  const outcome = await ctx.tools.execute('calendar.add_event', input, call);
  if (outcome.status === 'done') await tell(ctx, texts.eventAdded(action.title), `event:${message.id}`);
  else ctx.log.warn('mail triage: event was not added', { status: outcome.status });
}

async function todo(ctx: PluginContext, action: TodoSuggestion, message: MailMessage, texts: TriageTexts, call: ToolCallContext): Promise<void> {
  const input = {
    text: action.text,
    ...(action.due !== undefined ? { due: action.due } : {}),
    ...(action.evidence !== undefined && action.due !== undefined ? { evidence: action.evidence } : {}),
  };
  const outcome = await ctx.tools.execute('todo.add', input, call);
  if (outcome.status === 'done') await tell(ctx, texts.todoAdded(action.text), `todo:${message.id}`);
  else ctx.log.warn('mail triage: to-do was not added', { status: outcome.status });
}

/** The owner chose "팀에 맡기기": company mode queues it as owner-approved work, the mail is its source. */
async function handToTeam(ctx: PluginContext, action: TodoSuggestion, message: MailMessage, texts: TriageTexts): Promise<void> {
  const request = `${action.text}\n(${texts.fromNote(senderName(message.from), subjectOf(message, texts), action.evidence)})`;
  await ctx.bus.emit('company.intake', { request: request.slice(0, 2000), ref: `mail:${message.id}`, approvedByOwner: true });
  await tell(ctx, texts.teamHanded(action.text), `team:${message.id}`);
}

/** One suggestion the owner chose from the mail card; `choice` "team" hands a to-do to a team. */
export async function runSuggestion(ctx: PluginContext, action: Suggestion, message: MailMessage, texts: TriageTexts, choice: string): Promise<void> {
  await runOne(ctx, action, message, texts, choice);
}

async function runOne(ctx: PluginContext, action: Suggestion, message: MailMessage, texts: TriageTexts, choice: string): Promise<void> {
  const call: ToolCallContext = { grounding: mailGrounding(message) };
  if (action.kind === 'todo' && choice === 'team') await handToTeam(ctx, action, message, texts);
  else if (action.kind === 'reply') await reply(ctx, action, message, texts, call);
  else if (action.kind === 'event') await event(ctx, action, message, texts, call);
  else await todo(ctx, action, message, texts, call);
}

/**
 * Asks about each suggestion once (R15 topic per mail and kind) and, on a yes, runs it as a tool call through the
 * policy executor. A "yes" remembered from before is not acted on again: the mail was already handled.
 */
export async function offerSuggestions(
  ctx: PluginContext,
  message: MailMessage,
  actions: readonly Suggestion[],
  texts: TriageTexts,
): Promise<void> {
  const questions = ctx.tryUse(Contracts.questions);
  if (questions === undefined) return;
  const available = new Set(ctx.tools.list().map((tool) => tool.name));
  const teams = available.has(TEAM_TOOL);
  const asked = new Set<Suggestion['kind']>();
  for (const action of actions) {
    const usable = available.has(TOOL_FOR[action.kind]) || (action.kind === 'todo' && teams);
    if (asked.has(action.kind) || !usable) continue;
    asked.add(action.kind);
    const request = question(action, message, texts, { teams, todo: available.has(TOOL_FOR.todo) });
    if (!TOPIC.test(request.topic)) continue;
    try {
      const answer = await questions.ask(request);
      if (answer.status !== 'answered' || answer.means !== 'approved' || answer.reused) continue;
      // without todo.add the plain yes means "hand it to a team" too
      const choice = action.kind === 'todo' && !available.has(TOOL_FOR.todo) ? 'team' : answer.choice;
      await runOne(ctx, action, message, texts, choice);
    } catch (error) {
      ctx.log.warn('mail triage: suggestion failed', { kind: action.kind, error: error instanceof Error ? error.message : String(error) });
    }
  }
}
