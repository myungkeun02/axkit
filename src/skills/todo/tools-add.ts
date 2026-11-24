import { z } from 'zod';
import type { TodoItem } from '../../core/contracts/index.js';
import type { Tool } from '../../core/tools/types.js';
import type { DateSpec, TimeSpec } from '../../core/time/date-spec.js';
import { dateSpecSchema, resolveDate, resolveTime, timeSpecSchema, zonedIso } from '../../core/time/date-spec.js';
import { dateMentioned, evidenceFound, timeMentioned } from '../../core/time/evidence.js';
import { formatMoment } from './format.js';
import type { TodoTexts } from './locale.js';
import type { StoredTodo, TodoRepo } from './store.js';
import { guessNote, newTodoId, toTodoItem } from './tools-shared.js';

const EVIDENCE_HINT =
  "Verbatim quote of the words that state the date and time, copied from the owner's message or a mail you read; " +
  'never paraphrase. Give the date as a DateSpec (offset/weekday/month_day/date) instead of computing dates yourself.';

const dueInput = z.object({ date: dateSpecSchema, time: timeSpecSchema.optional() });

const addInput = z.object({
  text: z.string().min(1).max(200).describe('What to do.'),
  due: dueInput.optional().describe('Deadline; omit the time for a date-only deadline.'),
  remind: z.object({ date: dateSpecSchema, time: timeSpecSchema }).optional().describe('When to remind the owner.'),
  evidence: z
    .string()
    .min(2)
    .max(300)
    .optional()
    .describe(`${EVIDENCE_HINT} Required when due or remind is given.`),
});

export type TodoAddInput = z.infer<typeof addInput>;

interface AddDeps {
  store: TodoRepo;
  now: () => Date;
  timeZone: string;
  texts: TodoTexts;
}

function rejection(input: TodoAddInput, grounding: readonly string[]): string | undefined {
  if (input.due === undefined && input.remind === undefined) return undefined;
  if (input.evidence === undefined) return 'evidence is required when a due date or reminder is given';
  if (!evidenceFound(input.evidence, grounding)) {
    return "evidence was not found in this turn; quote the owner's words exactly";
  }
  if (input.due !== undefined) {
    if (!dateMentioned(input.due.date, input.evidence)) return 'the due date is not mentioned in the evidence';
    if (input.due.time !== undefined && !timeMentioned(input.due.time, input.evidence)) {
      return 'the due time is not mentioned in the evidence';
    }
  }
  if (input.remind !== undefined) {
    if (!dateMentioned(input.remind.date, input.evidence)) return 'the reminder date is not mentioned in the evidence';
    if (!timeMentioned(input.remind.time, input.evidence)) return 'the reminder time is not mentioned in the evidence';
  }
  return undefined;
}

function collectGuesses(
  value: { date: DateSpec; time?: TimeSpec | undefined } | undefined,
  now: Date,
  timeZone: string,
  guesses: string[],
): void {
  if (value === undefined) return;
  const resolved = resolveDate(value.date, now, timeZone);
  if (resolved.guess !== undefined) guesses.push(resolved.guess);
  if (value.time !== undefined) {
    const clock = resolveTime(value.time);
    if (clock.guess !== undefined) guesses.push(clock.guess);
  }
}

function guessesFor(input: TodoAddInput, now: Date, timeZone: string): string[] {
  const guesses: string[] = [];
  collectGuesses(input.due, now, timeZone, guesses);
  collectGuesses(input.remind, now, timeZone, guesses);
  return guesses;
}

function dueValue(input: NonNullable<TodoAddInput['due']>, now: Date, timeZone: string): string {
  const ymd = resolveDate(input.date, now, timeZone).ymd;
  return input.time === undefined ? ymd : zonedIso(ymd, resolveTime(input.time).hhmm, timeZone);
}

function remindValue(input: NonNullable<TodoAddInput['remind']>, now: Date, timeZone: string): string {
  const ymd = resolveDate(input.date, now, timeZone).ymd;
  return zonedIso(ymd, resolveTime(input.time).hhmm, timeZone);
}

function dueText(input: NonNullable<TodoAddInput['due']>, now: Date, timeZone: string, texts: TodoTexts): string {
  const resolved = resolveDate(input.date, now, timeZone);
  const hhmm = input.time === undefined ? undefined : resolveTime(input.time).hhmm;
  return formatMoment(resolved.ymd, hhmm, texts);
}

/** Tool "todo.add": writes the owner's to-do list, with reminders scheduled by time. */
export function todoAddTool(deps: AddDeps): Tool<TodoAddInput, TodoItem> {
  return {
    name: 'todo.add',
    description:
      "Add a to-do to the owner's list. When a due date or reminder is given, evidence must quote the words " +
      'that state it; relative dates must be given as a DateSpec.',
    input: addInput,
    effects: ['write'],
    reject: (input, call) => rejection(input, call.grounding),
    uncertainty: (input) => guessNote(guessesFor(input, deps.now(), deps.timeZone), deps.texts),
    describe(input) {
      const now = deps.now();
      const lines = [input.text];
      if (input.due !== undefined) {
        lines.push(`${deps.texts.dueLabel}: ${dueText(input.due, now, deps.timeZone, deps.texts)}`);
      }
      if (input.remind !== undefined) {
        lines.push(
          `${deps.texts.remindLabel}: ${dueText({ date: input.remind.date, time: input.remind.time }, now, deps.timeZone, deps.texts)}`,
        );
      }
      if (input.evidence !== undefined) lines.push(`${deps.texts.evidenceLabel}: "${input.evidence}"`);
      return lines.join('\n');
    },
    async run(input) {
      const now = deps.now();
      const due = input.due === undefined ? undefined : dueValue(input.due, now, deps.timeZone);
      const remindAt = input.remind === undefined ? undefined : remindValue(input.remind, now, deps.timeZone);
      const item: StoredTodo = {
        id: newTodoId(),
        text: input.text,
        done: false,
        createdAt: now.toISOString(),
        ...(due !== undefined ? { due } : {}),
        ...(remindAt !== undefined ? { remindAt } : {}),
      };
      return toTodoItem(await deps.store.add(item));
    },
  };
}
