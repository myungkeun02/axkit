import { z } from 'zod';
import type { Candidate } from '../../core/contracts/talent.js';
import type { Tool } from '../../core/tools/types.js';
import type { TalentStore } from './store.js';

const searchInput = z.object({
  text: z.string().max(200).optional().describe('Free words: skills, roles, industries, companies, schools. e.g. "자바 결제 핀테크".'),
  skills: z.array(z.string().max(40)).max(10).optional().describe('Skills every result must have.'),
  minYears: z.number().min(0).max(60).optional(),
  maxYears: z.number().min(0).max(60).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const getInput = z.object({ id: z.string().min(1).max(40) });

/** Without contact details: those only come with talent.get, for the one person the owner asked about. */
function card(candidate: Candidate): Record<string, unknown> {
  return {
    id: candidate.id,
    name: candidate.name,
    headline: candidate.headline,
    ...(candidate.years !== undefined ? { years: candidate.years } : {}),
    roles: candidate.roles,
    skills: candidate.skills.slice(0, 12),
    recent: candidate.career.slice(0, 2).map((step) => [step.company, step.role, step.period].filter((part) => part !== undefined).join(' · ')),
    ...(candidate.location !== undefined ? { location: candidate.location } : {}),
    ...(candidate.desired !== undefined ? { desired: candidate.desired } : {}),
    file: candidate.sources[0]?.path,
    updated: candidate.updatedAt.slice(0, 10),
  };
}

export function talentSearchTool(store: TalentStore): Tool<z.infer<typeof searchInput>, Record<string, unknown>> {
  return {
    name: 'talent.search',
    description:
      'Search the owner’s candidate list (people read from résumés on this computer) by skills, roles, years and free words. ' +
      'Use it to find people for a hiring request or an introduction. Results have no contact details.',
    input: searchInput,
    effects: ['read'],
    async run(input) {
      const found = await store.search({
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.skills !== undefined ? { skills: input.skills } : {}),
        ...(input.minYears !== undefined ? { minYears: input.minYears } : {}),
        ...(input.maxYears !== undefined ? { maxYears: input.maxYears } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      });
      return { total: await store.count(), results: found.map((item) => ({ ...card(item.candidate), score: item.score })) };
    },
  };
}

export function talentGetTool(store: TalentStore): Tool<z.infer<typeof getInput>, Record<string, unknown>> {
  return {
    name: 'talent.get',
    description: 'One candidate in full: career, education, what they want, contact details and the résumé files they came from.',
    input: getInput,
    effects: ['read'],
    async run(input) {
      const candidate = await store.get(input.id);
      if (candidate === undefined) return { found: false };
      return { found: true, ...card(candidate), career: candidate.career, ...(candidate.education !== undefined ? { education: candidate.education } : {}), summary: candidate.summary, contact: candidate.contact, files: candidate.sources };
    },
  };
}

export function talentStatsTool(store: TalentStore): Tool<Record<string, never>, Record<string, unknown>> {
  return {
    name: 'talent.stats',
    description: 'How many candidates the list holds and their most common skills.',
    input: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    effects: ['read'],
    async run() {
      return { candidates: await store.count(), topSkills: store.topSkills(15) };
    },
  };
}
