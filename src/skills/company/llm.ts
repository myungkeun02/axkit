import { z } from 'zod';
import type { LlmGateway } from '../../core/llm/types.js';
import type { Effect } from '../../core/policy/types.js';
import { planPrompt, reviewPrompt, routePrompt, stepPrompt } from './prompts.js';
import type { CompanyTask, TeamConfig } from './types.js';

const MAX_STEP_TEXT = 300;
const MAX_STEP_OUTPUT = 4000;
const MAX_TITLE = 120;
const MAX_NOTE = 500;
const OWNER_EFFECTS: readonly Effect[] = ['send', 'pay', 'delete', 'system'];

const routeSchema = z.object({ team: z.string().nullable() });

const planSchema = z.object({
  title: z.string(),
  steps: z.array(z.string()),
  ownerEffects: z.array(z.string()).default([]),
});

// Notes are clipped after parsing: an overlong note is still a usable review, not a parse failure.
const reviewSchema = z.object({
  verdict: z.enum(['pass', 'revise']),
  note: z.string().max(2000).default(''),
});

function parseError(): Error {
  return new Error('parse');
}

/** Models sometimes wrap JSON in a fenced block; anything else must already be JSON. */
function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  try {
    return JSON.parse(body);
  } catch {
    throw parseError();
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, text: string): T {
  const parsed = schema.safeParse(parseJson(text));
  if (!parsed.success) throw parseError();
  return parsed.data;
}

function isOwnerEffect(value: string): value is Effect {
  return (OWNER_EFFECTS as readonly string[]).includes(value);
}

const ROUTE_JSON = {
  type: 'object',
  properties: {
    team: { type: ['string', 'null'], description: 'Team id, or null when no team fits.' },
  },
  required: ['team'],
  additionalProperties: false,
};

const REVIEW_JSON = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'revise'] },
    note: { type: 'string', maxLength: MAX_NOTE, description: 'One short sentence for the member.' },
  },
  required: ['verdict', 'note'],
  additionalProperties: false,
};

function planJson(maxSteps: number): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      title: { type: 'string' },
      steps: {
        type: 'array',
        items: { type: 'string', maxLength: MAX_STEP_TEXT },
        minItems: 1,
        maxItems: maxSteps,
      },
      ownerEffects: { type: 'array', items: { type: 'string', enum: [...OWNER_EFFECTS] } },
    },
    required: ['title', 'steps', 'ownerEffects'],
    additionalProperties: false,
  };
}

function clipStep(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_STEP_TEXT ? trimmed : trimmed.slice(0, MAX_STEP_TEXT);
}

/** Routes a request to a configured team; an unknown id counts as no match. */
export async function routeTeam(
  llm: LlmGateway,
  teams: readonly TeamConfig[],
  request: string,
): Promise<string | undefined> {
  const response = await llm.complete({
    purpose: 'company.lead.route',
    tier: 'fast',
    sensitivity: 'masked',
    messages: routePrompt(teams, request),
    jsonSchema: ROUTE_JSON,
  });
  const parsed = parseOrThrow(routeSchema, response.text);
  if (parsed.team === null) return undefined;
  return teams.some((team) => team.id === parsed.team) ? parsed.team : undefined;
}

/** One lead plan: a title, member steps and the owner effects the work would need. */
export async function planTask(
  llm: LlmGateway,
  team: TeamConfig,
  task: CompanyTask,
  context: string,
  maxSteps: number,
  language = 'ko',
): Promise<{ title: string; steps: string[]; ownerEffects: Effect[] }> {
  const response = await llm.complete({
    purpose: 'company.lead.plan',
    tier: team.lead.tier,
    sensitivity: team.sensitivity,
    messages: planPrompt(team, task, context, maxSteps, language),
    jsonSchema: planJson(maxSteps),
  });
  const parsed = parseOrThrow(planSchema, response.text);
  const title = parsed.title.trim().slice(0, MAX_TITLE);
  const steps = parsed.steps
    .map(clipStep)
    .filter((step) => step !== '')
    .slice(0, maxSteps);
  if (title === '' || steps.length === 0) throw parseError();
  const ownerEffects = parsed.ownerEffects.filter(isOwnerEffect);
  return { title, steps, ownerEffects };
}

/** One member step, as plain text for the deliverable. */
export async function runStep(
  llm: LlmGateway,
  team: TeamConfig,
  task: CompanyTask,
  stepIndex: number,
  context: string,
  language = 'ko',
): Promise<string> {
  const response = await llm.complete({
    purpose: 'company.member.step',
    tier: team.member.tier,
    sensitivity: team.sensitivity,
    messages: stepPrompt(team, task, stepIndex, context, language),
  });
  return response.text.trim().slice(0, MAX_STEP_OUTPUT);
}

/** The lead's review of all member outputs: pass, or revise with one concrete note. */
export async function reviewTask(
  llm: LlmGateway,
  team: TeamConfig,
  task: CompanyTask,
  context: string,
  language = 'ko',
): Promise<{ verdict: 'pass' | 'revise'; note: string }> {
  const response = await llm.complete({
    purpose: 'company.lead.review',
    tier: team.lead.tier,
    sensitivity: team.sensitivity,
    messages: reviewPrompt(team, task, context, language),
    jsonSchema: REVIEW_JSON,
  });
  const parsed = parseOrThrow(reviewSchema, response.text);
  return { verdict: parsed.verdict, note: parsed.note.trim().slice(0, MAX_NOTE) };
}
