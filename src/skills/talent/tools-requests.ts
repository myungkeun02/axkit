import { z } from 'zod';
import type { PluginContext } from '../../core/plugin/types.js';
import type { Tool } from '../../core/tools/types.js';
import { matchRequest } from './match.js';
import type { HiringRequest, TalentBook } from './requests.js';
import { INTRO_STATUS, REQUEST_STATUS } from './requests.js';
import type { TalentStore } from './store.js';

type AnyTool = Tool<never, Record<string, unknown>>;

const requestFields = {
  company: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(80),
  skills: z.array(z.string().trim().min(1).max(40)).max(15).default([]),
  minYears: z.number().min(0).max(60).optional(),
  maxYears: z.number().min(0).max(60).optional(),
  location: z.string().max(80).optional(),
  notes: z.string().max(300).optional(),
};

function shown(request: HiringRequest): Record<string, unknown> {
  return {
    id: request.id,
    company: request.company,
    title: request.title,
    skills: request.skills,
    ...(request.minYears !== undefined ? { minYears: request.minYears } : {}),
    ...(request.maxYears !== undefined ? { maxYears: request.maxYears } : {}),
    ...(request.location !== undefined ? { location: request.location } : {}),
    ...(request.notes !== undefined ? { notes: request.notes } : {}),
    status: request.status,
    source: request.source,
    updated: request.updatedAt.slice(0, 10),
  };
}

function clean<T extends Record<string, unknown>>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}

/** Hiring requests, matching and the introduction log, as tools the assistant uses in chat and for drafts. */
export function requestTools(ctx: PluginContext, store: TalentStore, book: TalentBook, korean: boolean): AnyTool[] {
  const listInput = z.object({ status: z.enum([...REQUEST_STATUS, 'active']).optional(), company: z.string().max(80).optional() });
  const addInput = z.object(requestFields);
  const statusInput = z.object({ id: z.string().min(1).max(40), status: z.enum(REQUEST_STATUS) });
  const matchInput = z.object({
    requestId: z.string().min(1).max(40).optional().describe('A saved request; or give company/title/skills for a one-off search.'),
    ...Object.fromEntries(Object.entries(requestFields).map(([key, schema]) => [key, schema.optional()])),
    limit: z.number().int().min(1).max(20).optional(),
  });
  const logInput = z.object({
    candidateId: z.string().min(1).max(40),
    company: z.string().trim().min(1).max(80),
    requestId: z.string().max(40).optional(),
    status: z.enum(INTRO_STATUS),
    note: z.string().max(300).optional(),
  });
  const introsInput = z.object({ candidateId: z.string().max(40).optional(), company: z.string().max(80).optional(), requestId: z.string().max(40).optional() });

  const tools = [
    {
      name: 'talent.requests',
      description: 'List hiring requests (positions companies asked the owner to fill), newest first. status "active" = open or paused.',
      input: listInput,
      effects: ['read'],
      async run(input: z.infer<typeof listInput>) {
        return { requests: book.listRequests(clean(input)).slice(0, 50).map(shown) };
      },
    },
    {
      name: 'talent.add_request',
      description: 'Save a hiring request the owner mentions in chat (company, role, skills, years, place, conditions).',
      input: addInput,
      effects: ['write'],
      async run(input: z.infer<typeof addInput>) {
        const { request, created } = await book.upsertRequest({ ...clean(input), source: 'chat' }, ctx.clock.now());
        return { created, request: shown(request) };
      },
    },
    {
      name: 'talent.set_request',
      description: 'Change a hiring request status: open, paused, filled or closed.',
      input: statusInput,
      effects: ['write'],
      async run(input: z.infer<typeof statusInput>) {
        const request = await book.setRequestStatus(input.id, input.status, ctx.clock.now());
        return request === undefined ? { found: false } : { found: true, request: shown(request) };
      },
    },
    {
      name: 'talent.match',
      description:
        'Find people in the candidate list for a hiring request, ranked with a reason each. People already introduced to that company are left out and listed separately. No contact details.',
      input: matchInput,
      effects: ['read'],
      async run(input: z.infer<typeof matchInput>) {
        const saved = input.requestId !== undefined ? book.request(input.requestId) : undefined;
        if (input.requestId !== undefined && saved === undefined) return { found: false };
        const record = input as Record<string, unknown>;
        const adHoc: HiringRequest = {
          id: 'ad-hoc',
          company: typeof record['company'] === 'string' ? record['company'] : '',
          title: typeof record['title'] === 'string' ? record['title'] : '',
          skills: Array.isArray(record['skills']) ? (record['skills'] as string[]) : [],
          ...(typeof record['minYears'] === 'number' ? { minYears: record['minYears'] } : {}),
          ...(typeof record['location'] === 'string' ? { location: record['location'] } : {}),
          status: 'open',
          source: 'chat',
          createdAt: '',
          updatedAt: '',
        };
        const request = saved ?? adHoc;
        const result = await matchRequest({ llm: ctx.llm, log: ctx.log, korean }, store, book, request, input.limit ?? 5);
        return {
          request: saved === undefined ? { company: request.company, title: request.title } : shown(saved),
          by: result.by,
          matches: result.matches.map(({ candidate, fit, why }) => ({ id: candidate.id, name: candidate.name, headline: candidate.headline, years: candidate.years, fit, why })),
          alreadyIntroduced: result.skipped.map(({ candidate, intro }) => ({ id: candidate.id, name: candidate.name, status: intro.status, at: intro.at.slice(0, 10) })),
        };
      },
    },
    {
      name: 'talent.log_intro',
      description: 'Record or update an introduction: drafted, sent, interview, offer, hired, rejected or withdrawn. Call it after an introduction mail is sent or when the owner reports progress.',
      input: logInput,
      effects: ['write'],
      async run(input: z.infer<typeof logInput>) {
        const candidate = await store.get(input.candidateId);
        if (candidate === undefined) return { found: false };
        const intro = await book.logIntro({ ...clean(input), candidateName: candidate.name }, ctx.clock.now());
        return { found: true, intro };
      },
    },
    {
      name: 'talent.intros',
      description: 'Introductions made so far, by person, company or request, newest first.',
      input: introsInput,
      effects: ['read'],
      async run(input: z.infer<typeof introsInput>) {
        return { intros: book.listIntros(clean(input)).slice(0, 100) };
      },
    },
  ];
  return tools as unknown as AnyTool[];
}
