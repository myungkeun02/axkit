import type { PhoneSms } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { QuestionRequest } from '../../core/policy/questions.js';
import { TOPIC } from '../../core/policy/topics.js';
import type { ConfirmChoice } from '../../core/policy/types.js';
import type { ToolCallContext } from '../../core/tools/types.js';
import type { SmsReaderTexts } from './locale.js';
import { PARCEL_TOOL, followParcel } from './parcels.js';
import type { BillFound, Extraction, ReservationFound } from './types.js';

export const ASKED_BY = 'skill.sms-reader';

type Found = Exclude<Extraction, { kind: 'other' }>;
type ActionKind = Found['kind'];

const TOOL_FOR: Record<ActionKind, string> = {
  reservation: 'calendar.add_event',
  bill: 'todo.add',
  parcel: PARCEL_TOOL,
};

export interface ActionDeps {
  ctx: PluginContext;
  texts: SmsReaderTexts;
}

/** One topic per message and kind (R15): the same text is never asked about twice. */
export function topicFor(kind: ActionKind, ref: string): string {
  const id = ref.replace(/^sms:/, '').replace(/[^\p{L}\p{N}._-]/gu, '').slice(0, 64);
  return `sms:${kind}:${id === '' ? 'unknown' : id}`;
}

/** The standing rule the "from now on" box on a card makes, one per kind. */
export function autonomyKey(kind: ActionKind): { tool: string; scope: string } {
  return { tool: `sms-reader.${kind}`, scope: `sms:${kind}` };
}

function senderOf(sms: PhoneSms): string | undefined {
  const from = sms.from?.trim();
  return from === undefined || from === '' ? undefined : from.slice(0, 40);
}

async function tell(ctx: PluginContext, text: string, dedupeKey: string): Promise<void> {
  await ctx.tryUse(Contracts.notifier)?.notify({ kind: 'sms.read', text, dedupeKey }).catch(() => undefined);
}

function choices(yes: string, texts: SmsReaderTexts): ConfirmChoice[] {
  return [
    { id: 'yes', label: yes, tone: 'primary', means: 'approved' },
    { id: 'later', label: texts.later, means: 'later' },
    { id: 'no', label: texts.no, tone: 'danger', means: 'denied' },
  ];
}

function billTodo(found: BillFound, texts: SmsReaderTexts): string {
  return texts.billTodo(found.payee, found.amount).slice(0, 200);
}

function question(found: Found, sms: PhoneSms, texts: SmsReaderTexts): QuestionRequest {
  const sender = senderOf(sms);
  const base = { topic: topicFor(found.kind, sms.ref), askedBy: ASKED_BY, choices: choices(texts.yes[found.kind], texts) };
  switch (found.kind) {
    case 'reservation':
      return {
        ...base,
        effects: ['write'],
        summary: texts.reservationQuestion(texts.reservationTitle(found.org), found.status),
        note: texts.fromNote(sender, found.evidence, found.place),
      };
    case 'bill':
      return {
        ...base,
        effects: ['write'],
        summary: texts.billQuestion(billTodo(found, texts)),
        note: texts.fromNote(sender, found.evidence),
      };
    case 'parcel':
      return { ...base, effects: ['read'], summary: texts.parcelQuestion(found.carrier, found.invoice), note: texts.fromNote(sender, undefined) };
  }
}

async function addEvent(deps: ActionDeps, found: ReservationFound, sms: PhoneSms, call: ToolCallContext): Promise<void> {
  const title = deps.texts.reservationTitle(found.org).slice(0, 100);
  const input = {
    title,
    date: found.date,
    evidence: found.evidence,
    ...(found.time !== undefined ? { time: found.time } : {}),
    ...(found.place !== undefined ? { location: found.place.slice(0, 200) } : {}),
  };
  // the tool checks the quote again against the message and asks on its own card when the date is a guess
  const outcome = await deps.ctx.tools.execute('calendar.add_event', input, call);
  const output = outcome.status === 'done' ? (outcome.output as { status?: unknown } | undefined) : undefined;
  if (output?.status === 'created') await tell(deps.ctx, deps.texts.eventAdded(title), `event:${sms.ref}`);
  else if (outcome.status !== 'done') deps.ctx.log.warn('sms-reader: event was not added', { status: outcome.status });
}

async function addTodo(deps: ActionDeps, found: BillFound, sms: PhoneSms, call: ToolCallContext): Promise<void> {
  const text = billTodo(found, deps.texts);
  const input = {
    text,
    ...(found.due !== undefined && found.evidence !== undefined ? { due: { date: found.due }, evidence: found.evidence } : {}),
  };
  const outcome = await deps.ctx.tools.execute('todo.add', input, call);
  if (outcome.status === 'done') await tell(deps.ctx, deps.texts.todoAdded(text), `todo:${sms.ref}`);
  else deps.ctx.log.warn('sms-reader: to-do was not added', { status: outcome.status });
}

async function run(deps: ActionDeps, found: Found, sms: PhoneSms): Promise<void> {
  const call: ToolCallContext = { grounding: [sms.text] };
  if (found.kind === 'reservation') await addEvent(deps, found, sms, call);
  else if (found.kind === 'bill') await addTodo(deps, found, sms, call);
  else await followParcel(deps, found);
}

/** A standing "from now on" rule for this kind, when the owner made one; the stop switch still applies in the tools. */
async function standingRule(deps: ActionDeps, kind: ActionKind): Promise<boolean> {
  const rules = deps.ctx.tryUse(Contracts.autonomy);
  if (rules === undefined) return false;
  const key = autonomyKey(kind);
  const rule = await rules.find(key.tool, key.scope).catch(() => undefined);
  if (rule === undefined) return false;
  await rules.used(rule.id).catch(() => undefined);
  return true;
}

function rememberOffer(deps: ActionDeps, kind: ActionKind): QuestionRequest['remember'] {
  const rules = deps.ctx.tryUse(Contracts.autonomy);
  if (rules === undefined) return undefined;
  const key = autonomyKey(kind);
  const label = deps.texts.remember[kind];
  return {
    label,
    accept: async () => {
      await rules.add(key.tool, { key: key.scope, label });
    },
  };
}

/**
 * Reservation → calendar, bill → to-do, parcel → follow it. Asked once per message on a card; nothing is made without
 * the owner's yes unless a standing rule covers that kind. A cancelled booking only gets a notice: nothing is deleted.
 */
export async function offerAction(deps: ActionDeps, found: Found, sms: PhoneSms): Promise<void> {
  const { ctx, texts } = deps;
  if (found.kind === 'reservation' && found.status === 'cancelled') {
    await tell(ctx, texts.reservationCancelled(texts.reservationTitle(found.org), found.evidence), `cancelled:${sms.ref}`);
    return;
  }
  const available = new Set(ctx.tools.list().map((tool) => tool.name));
  if (!available.has(TOOL_FOR[found.kind])) return;
  if (await standingRule(deps, found.kind)) {
    await run(deps, found, sms);
    return;
  }
  const questions = ctx.tryUse(Contracts.questions);
  if (questions === undefined) return;
  const base = question(found, sms, texts);
  if (!TOPIC.test(base.topic)) return;
  const remember = rememberOffer(deps, found.kind);
  const answer = await questions.ask(remember !== undefined ? { ...base, remember } : base);
  // a "yes" remembered for this very message means it was already handled
  if (answer.status !== 'answered' || answer.means !== 'approved' || answer.reused) return;
  await run(deps, found, sms);
}
