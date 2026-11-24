import type { KnowledgeLine, ScanResult } from '../../core/contracts/knowledge.js';
import type { LlmGateway } from '../../core/llm/types.js';
import type { Logger } from '../../core/log/types.js';
import type { CachedSummary } from './cache.js';
import type { ProfileInput } from './fallback.js';
import type { OnboardingTexts } from './locale.js';
import { numbered, synthesizeProject } from './project-synth.js';
import type { WorkMap } from './work-map.js';
import { buildWorkMap } from './work-map.js';
import type { PickedProject } from './projects.js';

export interface HierarchyDeps {
  llm: LlmGateway;
  log: Logger;
  texts: OnboardingTexts;
  now: Date;
  /** "~/dev/app" for a real path. */
  display: (path: string) => string;
  onProject?: (done: number, total: number) => void;
}

export interface Hierarchy {
  /** What the work map found (who the owner is, where and on what they work); undefined without a model. */
  map?: WorkMap;
  /** One knowledge document per picked project, each filed under its company. */
  projects: KnowledgeLine[];
  /** One "회사·조직" profile line per company the owner picked projects in. */
  companies: KnowledgeLine[];
  /** What the overall profile is built from: loose summaries plus one line per project. */
  input: ProfileInput;
}

function belongsTo(summary: CachedSummary, project: PickedProject): boolean {
  return summary.project === project.path;
}

/**
 * Company → project → knowledge document. Each picked project gets its own synthesis from everything read in it
 * (repository, documents, sessions); the owner profile then only sees one line per project, so hundreds of session
 * summaries never crowd out the rest.
 */
export async function buildHierarchy(picked: readonly PickedProject[], input: ProfileInput, deps: HierarchyDeps): Promise<Hierarchy> {
  const at = deps.now.toISOString();
  const projects: KnowledgeLine[] = [];
  const briefs: CachedSummary[] = [];
  let done = 0;
  for (const project of picked) {
    const own = input.summaries.filter((summary) => belongsTo(summary, project));
    const display = deps.display(project.path);
    const result = await synthesizeProject({ llm: deps.llm, log: deps.log }, { ...project, display }, own, deps.texts, deps.now);
    projects.push(...result.lines);
    const purpose = result.lines.find((line) => line.key === 'purpose')?.text ?? own.find((summary) => summary.kind === 'repo')?.summary ?? project.name;
    const status = result.lines.find((line) => line.key === 'status')?.text;
    briefs.push({
      stamp: '',
      kind: 'repo',
      path: display,
      title: `${project.company} / ${project.name}`,
      modifiedAt: own.reduce((newest, summary) => (summary.modifiedAt > newest ? summary.modifiedAt : newest), ''),
      summary: status === undefined ? purpose : `${purpose} (${status})`,
      keywords: [project.company],
    });
    done += 1;
    deps.onProject?.(done, picked.length);
  }
  const loose = input.summaries.filter((summary) => !picked.some((project) => belongsTo(summary, project) || (summary.kind === 'repo' && summary.path === deps.display(project.path))));
  const map = await buildWorkMap({ llm: deps.llm, log: deps.log, texts: deps.texts }, { summaries: input.summaries, briefs, picked, signals: input.signals, stats: input.stats });
  if (map !== undefined) {
    const merged = mapLines(map, picked, projects, at);
    return { map, projects: merged.projects, companies: merged.companies, input: { ...input, summaries: [...briefs, ...loose] } };
  }
  const companies = [...new Set(picked.map((project) => project.company))].map((company) => ({
    area: 'profile',
    topic: 'org',
    key: company,
    text: `${company}: ${picked.filter((project) => project.company === company).map((project) => project.name).join(', ')}`,
    sources: ['setup'],
    at,
  }));
  return { projects, companies, input: { ...input, summaries: [...briefs, ...loose] } };
}

/**
 * The picked projects are what the owner chose: their documents replace any project the model guessed, and the
 * company lines replace a model "org" line about the same company.
 */
export function mergeHierarchy(result: ScanResult, hierarchy: Hierarchy): ScanResult {
  const names = new Set(hierarchy.companies.map((line) => line.key));
  const occupation = hierarchy.companies.some((line) => line.key === 'occupation');
  const profile = [...hierarchy.companies, ...result.profile.filter((line) => !(line.topic === 'org' && names.has(line.key)) && !(occupation && line.key === 'occupation'))];
  // Without a map or picks there is nothing better than the model's guessed projects.
  return { profile, projects: hierarchy.projects.length > 0 ? hierarchy.projects : result.projects };
}

const RELATION_KO: Record<string, string> = { employer: '다니는 곳', own: '내 사업', client: '고객사', partner: '협력사', personal: '개인' };

/**
 * The work map as knowledge lines: an occupation line, one line per organisation, and per project its company, kind,
 * recurring tasks and the roles its team is made from. A picked project keeps its detailed lines and the owner's company.
 */
export function mapLines(map: WorkMap, picked: readonly PickedProject[], detailed: readonly KnowledgeLine[], at: string): { projects: KnowledgeLine[]; companies: KnowledgeLine[] } {
  const projects: KnowledgeLine[] = [];
  const companies: KnowledgeLine[] = [];
  const line = (topic: string, key: string, text: string): KnowledgeLine => ({ area: 'project', topic, key, text, sources: ['first look'], at });
  if (map.occupation !== '') companies.push({ area: 'profile', topic: 'role', key: 'occupation', text: map.summary !== '' ? `${map.occupation} — ${map.summary}` : map.occupation, sources: ['first look'], at });
  const byCompany = new Map<string, { relation: string; names: string[] }>();
  const seen = new Set<string>();
  for (const org of map.orgs) {
    for (const project of org.projects) {
      const pick = project.path === undefined ? undefined : picked.find((item) => item.path === project.path);
      const company = pick?.company ?? org.name;
      seen.add(project.name);
      const own = detailed.filter((item) => item.topic === project.name);
      if (own.length > 0) projects.push(...own.filter((item) => item.key !== 'company'));
      else if (project.purpose !== '') projects.push(line(project.name, 'purpose', project.purpose));
      projects.push(line(project.name, 'company', company), line(project.name, 'kind', project.kind));
      if (pick?.remote !== undefined) projects.push(line(project.name, 'remote', pick.remote));
      project.tasks.forEach((task, index) => projects.push(line(project.name, numbered('tasks', index), task)));
      project.roles.forEach((role, index) => projects.push(line(project.name, numbered('role', index), `${role.title} — ${role.does}`)));
      const entry = byCompany.get(company) ?? { relation: org.relation, names: [] };
      entry.names.push(project.name);
      byCompany.set(company, entry);
    }
  }
  // A picked project the map left out still gets its document.
  for (const project of picked) {
    if (seen.has(project.name)) continue;
    projects.push(...detailed.filter((item) => item.topic === project.name));
    const entry = byCompany.get(project.company) ?? { relation: 'employer', names: [] };
    entry.names.push(project.name);
    byCompany.set(project.company, entry);
  }
  for (const [company, entry] of byCompany) {
    companies.push({ area: 'profile', topic: 'org', key: company, text: `${company} (${RELATION_KO[entry.relation] ?? entry.relation}): ${entry.names.join(', ')}`, sources: ['first look'], at });
  }
  return { projects, companies };
}
