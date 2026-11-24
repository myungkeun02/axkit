import type { KnowledgeLine, StoredKnowledgeLine } from '../../core/contracts/knowledge.js';
import type { KnowledgeTexts, ProfileTopic } from './locale.js';
import { profileTopicOf } from './render.js';

const FINISHED = /완료|종료|중단|done|archived/i;
const MAX_PROJECTS = 6;
const PROFILE_ORDER: readonly ProfileTopic[] = ['role', 'org', 'interest', 'other'];

function newestFirst<T extends { at: string; text: string }>(lines: readonly T[]): T[] {
  return [...lines].sort((left, right) => right.at.localeCompare(left.at) || left.text.localeCompare(right.text));
}

function projectGroups<T extends KnowledgeLine>(lines: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const line of lines) {
    if (line.area !== 'project') continue;
    const group = groups.get(line.topic) ?? [];
    group.push(line);
    groups.set(line.topic, group);
  }
  return groups;
}

function activeProjectNames(lines: readonly KnowledgeLine[]): string[] {
  const groups = projectGroups(lines);
  const names = [...groups.keys()].sort((left, right) => left.localeCompare(right));
  const active: string[] = [];
  for (const name of names) {
    const status = newestFirst((groups.get(name) ?? []).filter((line) => line.key === 'status'))[0];
    if (status !== undefined && FINISHED.test(status.text)) continue;
    active.push(name);
    if (active.length >= MAX_PROJECTS) break;
  }
  return active;
}

/** One prompt-sized paragraph about the owner, or undefined before anything is known. */
export function profileSummary(
  lines: readonly KnowledgeLine[],
  texts: KnowledgeTexts,
  maxChars: number,
): string | undefined {
  const profile = lines.filter((line) => line.area === 'profile');
  const joined = (topic: ProfileTopic): string | undefined => {
    const group = newestFirst(profile.filter((line) => profileTopicOf(line.topic) === topic));
    return group.length === 0 ? undefined : group.map((line) => line.text).join('; ');
  };

  const parts: string[] = [];
  const role = joined('role');
  const org = joined('org');
  const interest = joined('interest');
  if (role !== undefined) parts.push(`${texts.whatTheyDo}: ${role}`);
  if (org !== undefined) parts.push(`${texts.organization}: ${org}`);
  if (interest !== undefined) parts.push(`${texts.interests}: ${interest}`);
  const active = activeProjectNames(lines);
  if (active.length > 0) parts.push(`${texts.activeProjects}: ${active.join(', ')}`);
  if (parts.length === 0) return undefined;

  const summary = parts.join('. ');
  if (summary.length <= maxChars) return summary;
  if (maxChars <= 1) return '…';
  return `${summary.slice(0, maxChars - 1).trimEnd()}…`;
}

/** What the owner is asked to check: profile lines first, then one line per project that states a purpose. */
export function reviewLines(
  lines: readonly StoredKnowledgeLine[],
  texts: KnowledgeTexts,
): { id: string; text: string }[] {
  const profile = lines.filter((line) => line.area === 'profile');
  const review: { id: string; text: string }[] = [];
  for (const topic of PROFILE_ORDER) {
    const group = newestFirst(profile.filter((line) => profileTopicOf(line.topic) === topic));
    for (const line of group) review.push({ id: line.id, text: line.text });
  }

  const groups = projectGroups(lines);
  const names = [...groups.keys()].sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const purpose = newestFirst((groups.get(name) ?? []).filter((line) => line.key === 'purpose'))[0];
    if (purpose !== undefined) review.push({ id: purpose.id, text: texts.projectPurpose(name, purpose.text) });
  }
  return review;
}
