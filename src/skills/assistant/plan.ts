import { z } from 'zod';

const cut = (max: number) => (text: string): string => text.slice(0, max);
/** An array kept item by item: bad items are dropped, at most `max` kept, a non-array is empty. */
function lenient<T extends z.ZodTypeAny>(item: T, max: number) {
  return z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((items) => items.flatMap((value) => {
      const parsed = item.safeParse(value);
      return parsed.success ? [parsed.data as z.output<T>] : [];
    }).slice(0, max));
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /** For the approval card: who asked, when, what and why, in one or two sentences. Display only, never acted on. */
  why?: string;
}

export interface PlanQuestion {
  text: string;
  /** Best guess first. The channel renders one button per choice. */
  choices: readonly string[];
}

/** What this turn leaves behind, written by the model next to its reply; code decides what to keep. */
export interface PlanNotes {
  /** Lasting facts about the owner or their people/work worth recalling in later chats. */
  remember: readonly string[];
  /** Things left undecided this turn, each with what the assistant would do if the owner just agreed. */
  open: readonly { text: string; proposal: string }[];
  /** Ids from "Undecided from earlier" that this turn settled. */
  resolved: readonly string[];
  /** People the owner described this turn: who they are and what they are to the owner (person cards). */
  people?: readonly PlanPerson[];
}

export interface PlanPerson {
  name: string;
  title: string;
  company: string;
  relation: string;
  note: string;
}

/** The model's whole turn: what to say, what to run, and optionally one question. */
export interface Plan {
  reply: string;
  tool_calls: readonly ToolCall[];
  question: PlanQuestion | null;
  notes?: PlanNotes;
}

/** JSON Schema shown to the provider. Every field is required but nullable, which strict structured output needs. */
export const PLAN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'tool_calls', 'question', 'notes'],
  properties: {
    notes: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['remember', 'open', 'resolved', 'people'],
          properties: {
            remember: { type: 'array', maxItems: 3, items: { type: 'string' }, description: 'Lasting facts learned this turn (preferences, people, decisions). Empty if none.' },
            open: {
              type: 'array',
              maxItems: 2,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['text', 'proposal'],
                properties: {
                  text: { type: 'string', description: 'What is still undecided, in a few words.' },
                  proposal: { type: 'string', description: 'What you would do if the owner simply agreed.' },
                },
              },
            },
            resolved: { type: 'array', items: { type: 'string' }, description: 'Ids of earlier undecided items this turn settled.' },
            people: {
              type: 'array',
              maxItems: 3,
              description: 'People the owner described this turn (even in passing): their card. Empty if none.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'title', 'company', 'relation', 'note'],
                properties: {
                  name: { type: 'string', description: 'Name without honorifics.' },
                  title: { type: 'string', description: 'Job or role ("대표"), or "".' },
                  company: { type: 'string', description: 'Company or organisation, or "".' },
                  relation: { type: 'string', description: 'What they are to the owner ("내가 일하는 회사 대표"), or "".' },
                  note: { type: 'string', description: 'One short third-person line on what they are like or care about, or "".' },
                },
              },
            },
          },
        },
      ],
    },
    reply: { type: 'string', description: 'What to say to the owner. May be empty when only a question is needed.' },
    tool_calls: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'args', 'why'],
        properties: {
          name: { type: 'string', description: 'Tool name exactly as listed.' },
          args: { type: 'object', additionalProperties: true },
          why: {
            type: ['string', 'null'],
            description: "One or two plain sentences in the owner's language for the approval card: who asked, when, what, why (where or how much if it matters). Null for read-only tools.",
          },
        },
      },
    },
    question: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'choices'],
          properties: {
            text: { type: 'string' },
            choices: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: { type: 'string' },
              description: 'Multiple choice buttons, best guess first.',
            },
          },
        },
      ],
    },
  },
};

const planSchema = z.object({
  reply: z.string().default(''),
  tool_calls: z
    .array(
      z.object({
        name: z.string().min(1),
        args: z.record(z.string(), z.unknown()),
        why: z
          .string()
          .nullish()
          .transform((why) => (typeof why === 'string' && why.trim() !== '' ? why.trim().slice(0, 400) : undefined)),
      })
      .transform(({ why, ...call }) => (why !== undefined ? { ...call, why } : call)),
    )
    .max(3)
    .default([]),
  question: z
    .object({
      text: z.string().min(1),
      choices: z.array(z.string().min(1)).min(2).max(4),
    })
    .nullable()
    .default(null),
  // Loose on purpose: a malformed notes block never costs the reply.
  // Loose on purpose, item by item: one entry too long or malformed is cut or dropped, never the whole block.
  notes: z
    .object({
      remember: lenient(z.string().min(1).transform(cut(300)), 3),
      open: lenient(z.object({ text: z.string().min(1).transform(cut(200)), proposal: z.string().default('').transform(cut(300)) }), 2),
      resolved: lenient(z.string().min(1).max(40), 10),
      people: lenient(
        z.object({
          name: z.string().trim().min(1).transform(cut(60)),
          title: z.string().default('').transform(cut(40)),
          company: z.string().default('').transform(cut(60)),
          relation: z.string().default('').transform(cut(80)),
          note: z.string().default('').transform(cut(300)),
        }),
        3,
      ),
    })
    .nullish()
    .catch(null)
    .transform((notes) => notes ?? undefined),
});

export type PlanParse = { plan: Plan } | { error: string };

function stripFences(text: string): string {
  return text.replace(/```(?:json)?/gi, '').trim();
}

/** First balanced {...} block, ignoring braces inside strings. */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

/** Lenient parse: tolerate fences and surrounding prose, then validate the shape with zod. */
export function parsePlan(raw: string): PlanParse {
  const json = firstJsonObject(stripFences(raw));
  if (json === undefined) return { error: 'no JSON object found' };

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: issue === undefined ? 'invalid plan' : `${issue.path.join('.')}: ${issue.message}` };
  }
  const { notes, ...plan } = parsed.data;
  return { plan: notes !== undefined ? { ...plan, notes } : plan };
}
