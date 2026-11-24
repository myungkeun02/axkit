import type { KnowledgeLine } from '../../core/contracts/knowledge.js';
import type { Logger } from '../../core/log/types.js';
import { wallClock } from '../../core/scheduler/next-run.js';
import type { Clock } from '../../core/scheduler/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import { AREA_IDS } from './areas.js';
import type { AreaId } from './areas.js';
import type { KnowledgeTexts } from './locale.js';
import {
  areaTitleOf,
  changelogSection,
  profileTopicOf,
  prependChangelog,
  renderArea,
  renderProfile,
  renderCompany,
  COMPANY_KEY,
  renderProject,
  renderReadme,
} from './render.js';
import type { AreaRef, ChangeEntry, ChangelogChanges, ProjectRef } from './render.js';
import type { KnowledgeStore, StoredLine } from './store.js';
import { safeFileName } from './writer.js';
import type { DocWriter } from './writer.js';

export interface BuilderDeps {
  store: KnowledgeStore;
  kv: KeyValueStore;
  writer: DocWriter | undefined;
  texts: KnowledgeTexts;
  clock: Clock;
  timeZone: string;
  log: Logger;
}

const SNAPSHOT_KEY = 'snapshot';
const FILES_KEY = 'files';

const pad2 = (value: number): string => String(value).padStart(2, '0');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSnapshot(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const snapshot: Record<string, string> = {};
  for (const [id, text] of Object.entries(value)) {
    if (typeof text === 'string') snapshot[id] = text;
  }
  return snapshot;
}

function readFileList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function latestOf(lines: readonly StoredLine[]): StoredLine | undefined {
  let latest: StoredLine | undefined;
  for (const line of lines) {
    if (latest === undefined || line.at > latest.at) latest = line;
  }
  return latest;
}

function dateOf(line: StoredLine | undefined): string | undefined {
  return line === undefined ? undefined : line.at.slice(0, 10);
}

function labelOf(line: StoredLine, texts: KnowledgeTexts): string {
  if (line.area === 'profile') return texts.profileTopics[profileTopicOf(line.topic)];
  if (line.area === 'project') return line.topic;
  return areaTitleOf(texts, line.area);
}

function sortEntries(entries: ChangeEntry[]): ChangeEntry[] {
  return entries.sort((left, right) => left.label.localeCompare(right.label) || left.text.localeCompare(right.text));
}

function diffSnapshot(
  previous: Record<string, string>,
  current: ReadonlyMap<string, string>,
  lineById: ReadonlyMap<string, StoredLine>,
  texts: KnowledgeTexts,
): ChangelogChanges {
  const added: ChangeEntry[] = [];
  const changed: ChangeEntry[] = [];
  const removed: ChangeEntry[] = [];

  for (const [id, text] of current) {
    const before = previous[id];
    const line = lineById.get(id);
    const label = line === undefined ? '' : labelOf(line, texts);
    if (before === undefined) added.push({ label, text });
    else if (before !== text) changed.push({ label, text });
  }
  for (const [id, text] of Object.entries(previous)) {
    if (!current.has(id)) removed.push({ label: '', text });
  }

  return { added: sortEntries(added), changed: sortEntries(changed), removed: sortEntries(removed) };
}

function companyOf(group: readonly StoredLine[]): string | undefined {
  const text = latestOf(group.filter((line) => line.key === COMPANY_KEY))?.text.trim();
  return text === undefined || text === '' ? undefined : text;
}

function effectiveArea(area: string): AreaId {
  return (AREA_IDS as readonly string[]).includes(area) ? (area as AreaId) : 'other';
}

/** Renders the knowledge base as Markdown documents and keeps the snapshot the changelog is diffed against. */
export class KnowledgeBuilder {
  private docs = new Map<string, string>();
  private names: string[] = [];

  constructor(private readonly deps: BuilderDeps) {}

  document(name: string): string | undefined {
    return this.docs.get(name);
  }

  docNames(): readonly string[] {
    return this.names;
  }

  async rebuild(): Promise<{ files: string[] }> {
    const { store, texts, writer } = this.deps;
    const stamp = this.stamp();
    const lines = store.visible();

    const profile = lines.filter((line) => line.area === 'profile');
    const projects = this.groupProjects(lines);
    const areas = this.groupAreas(lines);
    const projectRefs = [...projects.entries()].map(([name, group]) => this.projectRef(name, group));
    const areaRefs = [...areas.entries()].map(([id, group]) => this.areaRef(id, group));
    const readmeData = { profileCount: profile.length, projects: projectRefs, areas: areaRefs };

    this.rememberDocuments(profile, projects, areas, readmeData, stamp);

    const files: string[] = [];
    if (writer !== undefined) {
      if (await writer.writeStable(texts.files.profile, (value) => renderProfile(profile, texts, value), stamp)) {
        files.push(texts.files.profile);
      }

      const generated: string[] = [];
      for (const [company, refs] of this.byCompany(projectRefs)) {
        const dir = `${texts.files.projectsDir}/${safeFileName(company)}`;
        const rel = `${dir}/${texts.files.readme}`;
        generated.push(rel);
        if (await writer.writeStable(rel, (value) => renderCompany(company, refs, texts, value, dir), stamp)) files.push(rel);
      }
      for (const [name, group] of projects) {
        const rel = this.projectFile(name, companyOf(group));
        generated.push(rel);
        if (await writer.writeStable(rel, (value) => renderProject(name, group, texts, value), stamp)) files.push(rel);
      }
      for (const [id, group] of areas) {
        const rel = this.areaFile(id);
        generated.push(rel);
        if (await writer.writeStable(rel, (value) => renderArea(id, group, texts, value), stamp)) files.push(rel);
      }

      if (await writer.writeStable(texts.files.readme, (value) => renderReadme(readmeData, texts, value), stamp)) {
        files.push(texts.files.readme);
      }

      const previousFiles = readFileList(await this.deps.kv.get<unknown>(FILES_KEY));
      for (const rel of previousFiles) {
        if (generated.includes(rel)) continue;
        if (await writer.remove(rel)) this.deps.log.debug('knowledge: removed a stale document', { file: rel });
      }
      await this.deps.kv.set(FILES_KEY, generated);
    }

    const existingSnapshot = readSnapshot(await this.deps.kv.get<unknown>(SNAPSHOT_KEY));
    const currentSnapshot = new Map(lines.map((line) => [line.id, line.text]));
    const section =
      existingSnapshot === undefined
        ? `## ${stamp}\n\n${texts.baseline(lines.length)}`
        : this.changelogOf(existingSnapshot, currentSnapshot, lines, stamp);

    if (writer !== undefined && section !== undefined) {
      const existing = await writer.read(texts.files.changelog);
      const next = prependChangelog(existing, section, texts);
      if (await writer.writeText(texts.files.changelog, next)) files.push(texts.files.changelog);
    }

    await this.deps.kv.set(SNAPSHOT_KEY, Object.fromEntries(currentSnapshot));
    return { files };
  }

  private changelogOf(
    previous: Record<string, string>,
    current: ReadonlyMap<string, string>,
    lines: readonly StoredLine[],
    stamp: string,
  ): string | undefined {
    const lineById = new Map(lines.map((line) => [line.id, line]));
    const changes = diffSnapshot(previous, current, lineById, this.deps.texts);
    if (changes.added.length === 0 && changes.changed.length === 0 && changes.removed.length === 0) return undefined;
    return changelogSection(stamp, changes, this.deps.texts);
  }

  private rememberDocuments(
    profile: readonly StoredLine[],
    projects: ReadonlyMap<string, readonly StoredLine[]>,
    areas: ReadonlyMap<string, readonly StoredLine[]>,
    readmeData: { profileCount: number; projects: ProjectRef[]; areas: AreaRef[] },
    stamp: string,
  ): void {
    const { texts } = this.deps;
    const docs = new Map<string, string>();
    const names = ['README', 'profile'];

    const profileText = renderProfile(profile, texts, stamp);
    docs.set('README', renderReadme(readmeData, texts, stamp));
    docs.set(texts.files.readme, docs.get('README') ?? '');
    docs.set('profile', profileText);
    docs.set(texts.files.profile, profileText);

    for (const [name, group] of projects) {
      const text = renderProject(name, group, texts, stamp);
      docs.set(name, text);
      names.push(name);
    }
    for (const [id, group] of areas) {
      const text = renderArea(id, group, texts, stamp);
      docs.set(id, text);
      docs.set(areaTitleOf(texts, id), text);
      names.push(id);
    }

    this.docs = docs;
    this.names = names;
  }

  private groupProjects(lines: readonly KnowledgeLine[]): Map<string, StoredLine[]> {
    const groups = new Map<string, StoredLine[]>();
    for (const line of lines) {
      if (line.area !== 'project') continue;
      const group = groups.get(line.topic) ?? [];
      group.push(line as StoredLine);
      groups.set(line.topic, group);
    }
    return new Map([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }

  private groupAreas(lines: readonly KnowledgeLine[]): Map<string, StoredLine[]> {
    const groups = new Map<string, StoredLine[]>();
    for (const line of lines) {
      if (line.area === 'profile' || line.area === 'project') continue;
      const id = effectiveArea(line.area);
      const group = groups.get(id) ?? [];
      group.push(line as StoredLine);
      groups.set(id, group);
    }
    return new Map(AREA_IDS.filter((id) => groups.has(id)).map((id) => [id, groups.get(id) ?? []]));
  }

  private byCompany(refs: readonly ProjectRef[]): Map<string, ProjectRef[]> {
    const out = new Map<string, ProjectRef[]>();
    for (const ref of refs) {
      if (ref.company === undefined) continue;
      out.set(ref.company, [...(out.get(ref.company) ?? []), ref]);
    }
    return out;
  }

  private projectRef(name: string, group: readonly StoredLine[]): ProjectRef {
    const status = latestOf(group.filter((line) => line.key === 'status'));
    const date = dateOf(latestOf(group));
    const company = companyOf(group);
    return {
      name,
      ...(company !== undefined ? { company } : {}),
      file: this.projectFile(name, company),
      ...(status !== undefined ? { status: status.text } : {}),
      ...(date !== undefined ? { date } : {}),
    };
  }

  private areaRef(id: string, group: readonly StoredLine[]): AreaRef {
    const date = dateOf(latestOf(group));
    return {
      id,
      file: this.areaFile(id),
      count: group.length,
      ...(date !== undefined ? { date } : {}),
    };
  }

  /** "프로젝트/회사/이름.md" when the project belongs to a company, else "프로젝트/이름.md". */
  private projectFile(name: string, company?: string): string {
    const dir = this.deps.texts.files.projectsDir;
    return company === undefined ? `${dir}/${safeFileName(name)}.md` : `${dir}/${safeFileName(company)}/${safeFileName(name)}.md`;
  }

  private areaFile(id: string): string {
    return `${this.deps.texts.files.areasDir}/${safeFileName(areaTitleOf(this.deps.texts, id))}.md`;
  }

  private stamp(): string {
    const wall = wallClock(this.deps.clock.now(), this.deps.timeZone);
    return `${wall.y}-${pad2(wall.m)}-${pad2(wall.d)} ${pad2(wall.hh)}:${pad2(wall.mm)} (${this.deps.timeZone})`;
  }
}
