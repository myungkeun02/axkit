import type { Doc, DocAuthor, DocStore } from '../../core/contracts/docs.js';
import type { ProfileSection } from './locale-work.js';
import type { TeamConfig } from './types.js';

const MAX_CONTEXT = 3000;
const MAX_DECISIONS = 5;

/** Words for the team documents; WorkTexts fits this shape. */
export interface TeamDocTexts {
  readonly scopeLabel: string;
  readonly decisionsTitle: string;
  readonly changelogTitle: string;
}

const COMPANY_SECTIONS: readonly ProfileSection[] = ['about', 'products', 'policies'];

export function teamDocId(teamId: string): string {
  return `company:team:${teamId}`;
}

export function decisionsDocId(teamId: string): string {
  return `company:decisions:${teamId}`;
}

export function changelogDocId(teamId: string): string {
  return `company:changelog:${teamId}`;
}

function marked(doc: Doc, body: string = doc.body): string {
  return doc.needsReview ? `(needs review) ${body}` : body;
}

/**
 * Creates the team's documents when they are missing. An existing doc is never overwritten: the owner may
 * have edited it, and the original assistant kept stale bot-owned copies over the owner's words.
 */
export async function ensureTeamDocs(
  docs: DocStore,
  teams: readonly TeamConfig[],
  texts: TeamDocTexts,
): Promise<void> {
  const author: DocAuthor = { kind: 'policy', id: 'config' };
  for (const team of teams) {
    const teamId = teamDocId(team.id);
    if ((await docs.get(teamId)) === undefined) {
      await docs.upsert({
        id: teamId,
        kind: 'team',
        scope: `team:${team.id}`,
        title: team.name,
        body: `${team.role}\n${texts.scopeLabel}: ${team.scope.join(', ')}`,
        author,
      });
    }
    const decisionsId = decisionsDocId(team.id);
    if ((await docs.get(decisionsId)) === undefined) {
      await docs.upsert({
        id: decisionsId,
        kind: 'decision',
        scope: `team:${team.id}`,
        title: `${team.name} — ${texts.decisionsTitle}`,
        body: '',
        author,
      });
    }
    const changelogId = changelogDocId(team.id);
    if ((await docs.get(changelogId)) === undefined) {
      await docs.upsert({
        id: changelogId,
        kind: 'changelog',
        scope: `team:${team.id}`,
        title: `${team.name} — ${texts.changelogTitle}`,
        body: '',
        author,
      });
    }
  }
}

/** What a team's models see: its own doc, the company profile docs and the newest decisions, clipped. */
export async function teamContext(docs: DocStore, teamId: string): Promise<string> {
  const parts: string[] = [];
  const team = await docs.get(teamDocId(teamId));
  if (team !== undefined && team.body.trim() !== '') parts.push(marked(team));

  for (const section of COMPANY_SECTIONS) {
    const doc = await docs.get(`company:${section}`);
    if (doc !== undefined && doc.body.trim() !== '') parts.push(marked(doc));
  }

  const decisions = await docs.get(decisionsDocId(teamId));
  const newest = [...(decisions?.entries ?? [])]
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, MAX_DECISIONS);
  if (newest.length > 0) {
    const block = newest.map((entry) => `- ${entry.text}`).join('\n');
    parts.push(decisions === undefined ? block : marked(decisions, block));
  }

  return parts.join('\n\n').slice(0, MAX_CONTEXT);
}

export async function logDecision(
  docs: DocStore,
  teamId: string,
  text: string,
  author: DocAuthor,
  sources: readonly string[],
): Promise<void> {
  await docs.append(decisionsDocId(teamId), { text, author, sources });
}

export async function logChange(
  docs: DocStore,
  teamId: string,
  text: string,
  author: DocAuthor,
  sources: readonly string[],
): Promise<void> {
  await docs.append(changelogDocId(teamId), { text, author, sources });
}

/** A team the owner made in chat (the bot directory): what it is for and who is in it, kept current. */
export interface DirectoryTeam {
  id: string;
  name: string;
  purpose?: string;
  members: readonly { name: string; role: string }[];
}

/**
 * Docs for the teams in the bot directory, written by code from the team and refreshed when it changes. `written`
 * holds what was written last time: a doc whose text differs from that was edited by the owner and stays theirs.
 */
export async function syncDirectoryTeamDocs(
  docs: DocStore,
  teams: readonly DirectoryTeam[],
  texts: { readonly membersLabel: string },
  written: Map<string, string>,
): Promise<void> {
  const author: DocAuthor = { kind: 'policy', id: 'bots' };
  for (const team of teams) {
    const id = teamDocId(team.id);
    const body = [team.purpose ?? '', `${texts.membersLabel}:`, ...team.members.map((member) => `- ${member.name}: ${member.role}`)].filter((line) => line !== '').join('\n');
    const existing = await docs.get(id);
    if (existing !== undefined && (existing.body === body || existing.body !== written.get(id))) continue;
    await docs.upsert({ id, kind: 'team', scope: `team:${team.id}`, title: team.name, body, author });
    written.set(id, body);
  }
}
