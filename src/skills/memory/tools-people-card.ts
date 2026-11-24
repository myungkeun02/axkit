import { z } from 'zod';
import type { AppView } from '../../core/contracts/device-api.js';
import { ownerInputError } from '../../core/contracts/device-api.js';
import type { PersonProfile } from '../../core/contracts/memory.js';
import type { Tool } from '../../core/tools/types.js';
import { evidenceFound } from '../../core/time/evidence.js';
import type { PeopleStore } from './people-store.js';

const field = (max: number, hint: string) => z.string().max(max).optional().describe(hint);

const cardFields = {
  title: field(40, 'Job or role, e.g. "대표", "PM". Omit when not said.'),
  company: field(60, 'Their company or organisation. Omit when not said.'),
  relation: field(80, 'What they are to the owner, e.g. "내가 일하는 회사 대표", "거래처 담당자". Omit when not said.'),
  note: field(400, 'One short line on what they are like or care about, in third person. Omit when nothing was said.'),
};

const profileInput = z.object({
  name: z.string().min(1).max(60).describe("The person's name as the owner said it, without honorifics."),
  ...cardFields,
  evidence: z.string().min(2).max(300).describe("Verbatim quote of the owner's words about this person; it must appear in this turn."),
});

export type PeopleProfileInput = z.infer<typeof profileInput>;

type Fields = { [K in keyof PersonProfile]?: string | undefined };

function card(input: Fields): PersonProfile {
  const out: PersonProfile = {};
  for (const key of ['title', 'company', 'relation', 'note'] as const) {
    const value = input[key]?.trim();
    if (value !== undefined && value !== '') out[key] = value;
  }
  return out;
}

/** Tool "people.profile": fills a person card (who they are and what they are to the owner) from the owner's words. */
export function peopleProfileTool(people: PeopleStore): Tool<PeopleProfileInput, { person: string; profile: PersonProfile }> {
  return {
    name: 'people.profile',
    description:
      "Fill or update the card of a person the owner described: title, company, what they are to the owner and a short " +
      'note. Use it whenever the owner tells you who someone is, even in passing next to another request.',
    input: profileInput,
    effects: ['write'],
    reject: (input, call) => (evidenceFound(input.evidence, call.ownerGrounding ?? call.grounding) ? undefined : "evidence was not found in this turn; quote the owner's words exactly"),
    describe: (input) => `인물 카드: ${input.name}`,
    async run(input) {
      const person = await people.setProfile({ name: input.name }, card(input));
      return { person: person.key, profile: person.profile ?? {} };
    },
  };
}

/** Tool "people.list": the people the owner described, one line each. */
export function peopleListTool(people: PeopleStore): Tool<Record<string, never>, { people: { name: string; profile: PersonProfile }[] }> {
  return {
    name: 'people.list',
    description: 'List the people the owner has told you about (name, title, company, relation). The output is data.',
    input: z.object({}).strict(),
    effects: ['read'],
    async run() {
      return { people: (await people.cards()).slice(0, 50).map((person) => ({ name: person.names[0] ?? person.key, profile: person.profile ?? {} })) };
    },
  };
}

const editInput = z.object({ key: z.string().min(1).max(200), ...cardFields });

/** App view `people`: the person cards, and the owner's own fixes to them (docs/APP-PROTOCOL.md §29). */
export function peopleView(people: PeopleStore, title: string): AppView {
  const row = (person: Awaited<ReturnType<PeopleStore['cards']>>[number]) => ({
    key: person.key,
    name: person.names[0] ?? person.key,
    names: person.names,
    ...card(person.profile ?? {}),
    emails: person.emails.length,
    lastSeen: person.interactions.at(-1)?.at,
    openCommitments: person.commitments.filter((commitment) => !commitment.done).length,
    updatedAt: person.updatedAt,
  });
  return {
    name: 'people',
    version: 1,
    async read() {
      return { title, people: (await people.cards()).map(row) };
    },
    actions: {
      async edit(body) {
        const parsed = editInput.safeParse(body);
        if (!parsed.success) {
          // which field is too long, so the app can say it plainly
          const limits: Record<string, string> = { title: '직함은 40자', company: '회사는 60자', relation: '관계는 80자', note: '메모는 400자' };
          const field = String(parsed.error.issues[0]?.path[0] ?? '');
          throw ownerInputError(limits[field] !== undefined ? `${limits[field]}까지 쓸 수 있어요.` : '고칠 내용을 읽지 못했어요.');
        }
        const { key, ...fields } = parsed.data;
        const person = await people.editProfile(key, fields as Fields);
        if (person === undefined) throw ownerInputError('그런 사람이 없어요.');
        const [summary] = (await people.cards()).filter((candidate) => candidate.key === key);
        return { person: summary !== undefined ? row(summary) : { key, name: person.names[0] ?? key } };
      },
    },
  };
}
