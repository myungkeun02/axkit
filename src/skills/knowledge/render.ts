import type { KnowledgeLine, StoredKnowledgeLine } from '../../core/contracts/knowledge.js';
import { AREA_IDS } from './areas.js';
import type { AreaId } from './areas.js';
import type { KnowledgeTexts, ProfileTopic, ProjectSection } from './locale.js';

/** Lines arrive from the store with an origin; bare contract lines are still accepted by the renderers. */
export type RenderLine = KnowledgeLine & Partial<Pick<StoredKnowledgeLine, 'id' | 'origin'>>;

export interface ProjectRef {
  name: string;
  company?: string;
  file: string;
  status?: string;
  date?: string;
}

export interface AreaRef {
  id: string;
  file: string;
  count: number;
  date?: string;
}

export interface ReadmeData {
  profileCount: number;
  projects: readonly ProjectRef[];
  areas: readonly AreaRef[];
}

export interface ChangeEntry {
  label: string;
  text: string;
}

export interface ChangelogChanges {
  added: readonly ChangeEntry[];
  changed: readonly ChangeEntry[];
  removed: readonly ChangeEntry[];
}

const PROFILE_ORDER: readonly ProfileTopic[] = ['role', 'org', 'interest', 'other'];
const PROJECT_ORDER: readonly ProjectSection[] = ['purpose', 'status', 'tasks', 'role', 'stack', 'decisions', 'open', 'recent', 'people', 'files', 'other'];
/** Lines that only file the project or set its team kind; not shown as sections. */
const HIDDEN_KEYS = new Set(['company', 'kind', 'remote']);
/** The key of the line that files a project under a company. */
export const COMPANY_KEY = 'company';

export function profileTopicOf(topic: string): ProfileTopic {
  return topic === 'role' || topic === 'org' || topic === 'interest' ? topic : 'other';
}

/** "decisions-2" is the second line of "decisions". */
function projectSectionOf(key: string): ProjectSection {
  const base = key.replace(/-\d+$/, '');
  return (PROJECT_ORDER as readonly string[]).includes(base) ? (base as ProjectSection) : 'other';
}

export function areaTitleOf(texts: KnowledgeTexts, areaId: string): string {
  return (AREA_IDS as readonly string[]).includes(areaId) ? texts.areaTitles[areaId as AreaId] : texts.areaTitles.other;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim();
}

function dateOf(at: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(at);
  return match?.[1] ?? at.slice(0, 10);
}

function newestFirst(lines: readonly RenderLine[]): RenderLine[] {
  return [...lines].sort((left, right) => right.at.localeCompare(left.at) || left.text.localeCompare(right.text));
}

function bullet(line: RenderLine, texts: KnowledgeTexts): string {
  const date = dateOf(line.at);
  if (line.origin === 'correction') return `- ${oneLine(line.text)} _(${texts.correctedLabel} · ${date})_`;
  const citation =
    line.sources.length > 0
      ? `${texts.sourceLabel}: ${line.sources.map(oneLine).join(', ')} · ${date}`
      : date;
  return `- ${oneLine(line.text)} _(${citation})_`;
}

function sectionOf(title: string, lines: readonly RenderLine[], texts: KnowledgeTexts): string {
  const sorted = newestFirst(lines);
  // Lines that all cite the same files and day say so once under the section, not on every line.
  const key = (line: RenderLine): string => `${line.sources.map(oneLine).join(', ')}|${dateOf(line.at)}`;
  const first = sorted[0];
  const shared = sorted.length > 1 && first !== undefined && first.sources.length > 0 && sorted.every((line) => line.origin !== 'correction' && key(line) === key(first));
  if (!shared || first === undefined) return `## ${oneLine(title)}\n\n${sorted.map((line) => bullet(line, texts)).join('\n')}`;
  const bullets = sorted.map((line) => `- ${oneLine(line.text)}`);
  return `## ${oneLine(title)}\n\n${bullets.join('\n')}\n\n_(${texts.sourceLabel}: ${first.sources.map(oneLine).join(', ')} · ${dateOf(first.at)})_`;
}

function documentOf(
  title: string,
  detail: string,
  sections: readonly { title: string; lines: readonly RenderLine[] }[],
  texts: KnowledgeTexts,
  stamp: string,
): string {
  const head = `# ${oneLine(title)}\n\n${texts.updatedLine(detail, stamp)}`;
  const body = sections
    .filter((section) => section.lines.length > 0)
    .map((section) => sectionOf(section.title, section.lines, texts))
    .join('\n\n');
  return body.length > 0 ? `${head}\n\n${body}\n` : `${head}\n`;
}

export function renderProfile(lines: readonly RenderLine[], texts: KnowledgeTexts, stamp: string): string {
  const sections = PROFILE_ORDER.map((topic) => ({
    title: texts.profileTopics[topic],
    lines: lines.filter((line) => profileTopicOf(line.topic) === topic),
  }));
  return documentOf(texts.profileTitle, texts.lineCount(lines.length), sections, texts, stamp);
}

export function renderProject(
  name: string,
  lines: readonly RenderLine[],
  texts: KnowledgeTexts,
  stamp: string,
): string {
  const company = lines.find((line) => line.key === COMPANY_KEY);
  const body = lines.filter((line) => !HIDDEN_KEYS.has(line.key));
  const sections = PROJECT_ORDER.map((key) => ({
    title: texts.projectSections[key],
    lines: body.filter((line) => projectSectionOf(line.key) === key),
  }));
  const detail = company === undefined ? texts.lineCount(body.length) : `${texts.companyLine(oneLine(company.text))} · ${texts.lineCount(body.length)}`;
  return documentOf(name, detail, sections, texts, stamp);
}

export function renderArea(
  areaId: string,
  lines: readonly RenderLine[],
  texts: KnowledgeTexts,
  stamp: string,
): string {
  const byTopic = new Map<string, RenderLine[]>();
  for (const line of lines) {
    const topic = oneLine(line.topic) || texts.areaTitles.other;
    const group = byTopic.get(topic) ?? [];
    group.push(line);
    byTopic.set(topic, group);
  }
  const sections = [...byTopic.entries()]
    .map(([title, group]) => ({ title, lines: newestFirst(group) }))
    .sort((left, right) => {
      const leftNewest = left.lines[0]?.at ?? '';
      const rightNewest = right.lines[0]?.at ?? '';
      return rightNewest.localeCompare(leftNewest) || left.title.localeCompare(right.title);
    });
  return documentOf(areaTitleOf(texts, areaId), texts.lineCount(lines.length), sections, texts, stamp);
}

export function renderReadme(data: ReadmeData, texts: KnowledgeTexts, stamp: string): string {
  const head = `# ${texts.title}\n\n${texts.updatedLine(
    texts.readmeSummary(data.profileCount, data.projects.length, data.areas.length),
    stamp,
  )}`;

  const blocks = [`## ${texts.profileHeading}\n\n${texts.readmeProfileLine(texts.files.profile, data.profileCount)}`];
  if (data.projects.length > 0) {
    const line = (project: ProjectRef): string =>
      texts.readmeProjectLine(oneLine(project.name), project.file, project.status === undefined ? undefined : oneLine(project.status), project.date);
    const companies = [...new Set(data.projects.map((project) => project.company ?? ''))];
    const parts = companies.map((company) => {
      const bullets = data.projects.filter((project) => (project.company ?? '') === company).map(line).join('\n');
      return company === '' ? bullets : `### ${oneLine(company)}\n\n${bullets}`;
    });
    blocks.push(`## ${texts.projectsHeading}\n\n${parts.join('\n\n')}`);
  }
  if (data.areas.length > 0) {
    const bullets = data.areas.map((area) =>
      texts.readmeAreaLine(areaTitleOf(texts, area.id), area.file, area.count, area.date),
    );
    blocks.push(`## ${texts.areasHeading}\n\n${bullets.join('\n')}`);
  }

  return `${head}\n\n${blocks.join('\n\n')}\n`;
}

function changeBlock(label: string, entries: readonly ChangeEntry[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map((entry) =>
    entry.label.length > 0 ? `- ${oneLine(entry.label)}: ${oneLine(entry.text)}` : `- ${oneLine(entry.text)}`,
  );
  return `**${label}**\n${lines.join('\n')}`;
}

export function changelogSection(stamp: string, changes: ChangelogChanges, texts: KnowledgeTexts): string {
  const blocks = [
    changeBlock(texts.addedLabel, changes.added),
    changeBlock(texts.changedLabel, changes.changed),
    changeBlock(texts.removedLabel, changes.removed),
  ].filter((block) => block.length > 0);
  return blocks.length > 0 ? `## ${stamp}\n\n${blocks.join('\n\n')}` : `## ${stamp}`;
}

/** Newest section first, under a header that stays byte-identical across runs. */
export function prependChangelog(existing: string | undefined, section: string, texts: KnowledgeTexts): string {
  const body = `${section.trim()}\n`;
  if (existing === undefined || existing.trim().length === 0) return `${texts.changelogHeader}\n\n${body}`;
  const at = existing.indexOf('\n## ');
  if (at < 0) return `${existing.trimEnd()}\n\n${body}`;
  return `${existing.slice(0, at + 1)}${body}\n${existing.slice(at + 1)}`;
}

/** One company's index: its projects, newest first. */
export function renderCompany(company: string, projects: readonly ProjectRef[], texts: KnowledgeTexts, stamp: string, relativeTo: string): string {
  const bullets = projects.map((project) =>
    texts.readmeProjectLine(
      oneLine(project.name),
      project.file.startsWith(`${relativeTo}/`) ? project.file.slice(relativeTo.length + 1) : project.file,
      project.status === undefined ? undefined : oneLine(project.status),
      project.date,
    ),
  );
  return `# ${oneLine(company)}\n\n${texts.updatedLine(texts.companyIndex(oneLine(company), projects.length), stamp)}\n\n${bullets.join('\n')}\n`;
}
