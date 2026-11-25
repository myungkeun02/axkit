import type { MailMessage } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ConfirmChoice } from '../../core/policy/types.js';
import { TOPIC } from '../../core/policy/topics.js';
import { resolveDate, zonedIso } from '../../core/time/date-spec.js';
import type { ToolCallContext } from '../../core/tools/types.js';
import type { AttachmentNote } from './attachment-memory.js';
import { ASKED_BY, runSuggestion } from './triage-actions.js';
import type { TriageTexts } from './triage-locale.js';
import { senderName } from './triage-locale.js';
import type { EventSuggestion, ReplySuggestion, Suggestion, TodoSuggestion, Triage } from './triage-model.js';
import { mailGrounding } from './triage-model.js';

const TEAM_TOOL = 'company.submit';
const LOOK_AHEAD_DAYS = 60;

export interface AskInput {
  message: MailMessage;
  triage: Triage;
  /** Only suggestions the owner may be offered (a reply only when a person is waiting). */
  actions: readonly Suggestion[];
  notes: readonly AttachmentNote[];
  meetLink?: string;
  /** Writes the reply draft (with files, free times and facts) and asks whether to send it. */
  draft(reply: ReplySuggestion): Promise<void>;
}

async function tell(ctx: PluginContext, text: string, dedupeKey: string): Promise<void> {
  await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'mail.triage', text, dedupeKey }).catch(() => undefined);
}

function first<K extends Suggestion['kind']>(actions: readonly Suggestion[], kind: K): Extract<Suggestion, { kind: K }> | undefined {
  return actions.find((action): action is Extract<Suggestion, { kind: K }> => action.kind === kind);
}

/** The choices this mail really has; empty when there is nothing to do but know about it. */
export function mailChoices(ctx: PluginContext, input: AskInput, texts: TriageTexts): ConfirmChoice[] {
  const tools = new Set(ctx.tools.list().map((tool) => tool.name));
  const list: ConfirmChoice[] = [];
  if (first(input.actions, 'reply') !== undefined && tools.has('mail.draft_reply')) list.push({ id: 'reply', label: texts.chooseReply, tone: 'primary', means: 'approved' });
  if (input.notes.length > 0) list.push({ id: 'files', label: texts.chooseFiles, means: 'approved' });
  const event = first(input.actions, 'event');
  if (input.meetLink !== undefined || input.triage.kind === 'invitation') {
    if (ctx.tryUse(Contracts.calendarRead) !== undefined) list.push({ id: 'meeting', label: texts.chooseMeeting, means: 'approved' });
  } else if (event !== undefined && tools.has('calendar.add_event')) {
    list.push({ id: 'event', label: texts.chooseEvent, means: 'approved' });
  }
  if (first(input.actions, 'todo') !== undefined) {
    if (tools.has('todo.add')) list.push({ id: 'todo', label: texts.chooseTodo, means: 'approved' });
    if (tools.has(TEAM_TOOL)) list.push({ id: 'team', label: texts.teamYes, detail: texts.teamDetail, means: 'approved' });
  }
  if (list.length === 0) return [];
  return [...list, { id: 'later', label: texts.later, means: 'later' }, { id: 'no', label: texts.no, means: 'denied' }];
}

/**
 * The owner hears what came first ("민수님 메일: 견적 요청 …"), then picks what to do: write a reply, read what the
 * attached files say, put the meeting on the calendar (with its link ten minutes before), make it a to-do. Nothing
 * is written for them before they choose.
 */
export async function askAboutMail(ctx: PluginContext, input: AskInput, texts: TriageTexts): Promise<void> {
  const questions = ctx.tryUse(Contracts.questions);
  const choices = mailChoices(ctx, input, texts);
  if (questions === undefined || choices.length === 0) return;
  const { message, triage } = input;
  const who = senderName(message.from);
  const subject = message.subject === '' ? texts.noSubject : message.subject;
  const topic = `mail:ask:${message.id}`;
  if (!TOPIC.test(topic)) return;
  const note = [triage.summary, ...(input.notes.length > 0 ? [texts.filesLine(input.notes.map((item) => item.filename))] : []), ...(input.meetLink !== undefined ? [texts.meetLine(input.meetLink)] : [])].join('\n');
  const answer = await questions.ask({ topic, askedBy: ASKED_BY, summary: texts.askWhat(who, subject), note, choices, effects: ['write'] });
  if (answer.status !== 'answered' || answer.means !== 'approved' || answer.reused) return;
  const call: ToolCallContext = { grounding: mailGrounding(message) };
  switch (answer.choice) {
    case 'reply': {
      const reply = first(input.actions, 'reply');
      if (reply !== undefined) await input.draft(reply);
      return;
    }
    case 'files':
      await tell(ctx, [texts.filesTitle, ...input.notes.map((item) => `- ${item.filename}: ${item.summary}`)].join('\n'), `files:${message.id}`);
      return;
    case 'meeting':
      await meeting(ctx, message, first(input.actions, 'event'), input.meetLink, texts, call);
      return;
    case 'event':
    case 'todo':
    case 'team': {
      const action: EventSuggestion | TodoSuggestion | undefined = answer.choice === 'event' ? first(input.actions, 'event') : first(input.actions, 'todo');
      if (action !== undefined) await runSuggestion(ctx, action, message, texts, answer.choice);
      return;
    }
  }
}

/** Already on the calendar: say so; not yet: add it (with the link as its place). The link comes ten minutes before. */
async function meeting(ctx: PluginContext, message: MailMessage, event: EventSuggestion | undefined, link: string | undefined, texts: TriageTexts, call: ToolCallContext): Promise<void> {
  const calendar = ctx.tryUse(Contracts.calendarRead);
  if (calendar === undefined) return;
  const zone = ctx.assistant.timezone;
  const now = ctx.clock.now();
  let from = now;
  let to = new Date(now.getTime() + LOOK_AHEAD_DAYS * 86_400_000);
  if (event !== undefined) {
    const ymd = resolveDate(event.date, now, zone).ymd;
    from = new Date(zonedIso(ymd, '00:00', zone));
    to = new Date(from.getTime() + 86_400_000);
  }
  const events = await calendar.listEvents({ from, to }).catch(() => []);
  const title = event?.title.trim().toLowerCase();
  const found = events.find((item) => (link !== undefined && (item.meetLink === link || item.location?.includes(link) === true)) || (title !== undefined && title !== '' && item.title.trim().toLowerCase() === title));
  const remind = (found?.meetLink ?? link) !== undefined ? texts.meetRemind : '';
  if (found !== undefined) {
    await tell(ctx, [texts.meetFound(found.title), remind].filter((line) => line !== '').join('\n'), `meeting:${message.id}`);
    return;
  }
  if (event === undefined) {
    await tell(ctx, texts.meetNoDate(link), `meeting:${message.id}`);
    return;
  }
  const outcome = await ctx.tools.execute(
    'calendar.add_event',
    { title: event.title, date: event.date, evidence: event.evidence, ...(event.time !== undefined ? { time: event.time } : {}), ...(link !== undefined ? { location: link } : {}) },
    call,
  );
  if (outcome.status === 'done') await tell(ctx, [texts.eventAdded(event.title), remind].filter((line) => line !== '').join('\n'), `meeting:${message.id}`);
  else ctx.log.warn('mail triage: the meeting was not added', { status: outcome.status });
}
