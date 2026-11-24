import type { KnowledgeLine, ScanResult } from '../../core/contracts/knowledge.js';
import type { CachedSummary } from './cache.js';
import { ACTIVE_FOLDERS_LABEL } from './items.js';
import type { OnboardingTexts } from './locale.js';
import type { SignalLine } from './signals.js';

export interface ProfileInput {
  summaries: CachedSummary[];
  stats: string[];
  signals: SignalLine[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_DAYS = 30;
const MAX_FALLBACK_PROJECTS = 15;
const MAX_TOPIC_CHARS = 60;

function repoTime(summary: CachedSummary): number {
  let newest = Date.parse(summary.modifiedAt);
  for (const keyword of summary.keywords) {
    const match = /(\d{4}-\d{2}-\d{2})/.exec(keyword);
    if (match?.[1] === undefined) continue;
    const parsed = Date.parse(match[1]);
    if (Number.isFinite(parsed) && (!Number.isFinite(newest) || parsed > newest)) newest = parsed;
  }
  return Number.isFinite(newest) ? newest : 0;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))];
}

/** Code-only profile from cached repo summaries and folder statistics; every line cites its source. */
export function fallbackProfile(input: ProfileInput, texts: OnboardingTexts, now: Date): ScanResult {
  const at = now.toISOString();
  const projects: KnowledgeLine[] = [];
  const profile: KnowledgeLine[] = [];
  const repos = input.summaries
    .filter((summary) => summary.kind === 'repo')
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt))
    .slice(0, MAX_FALLBACK_PROJECTS);

  for (const repo of repos) {
    const topic = repo.title.trim().slice(0, MAX_TOPIC_CHARS);
    if (topic === '') continue;
    const sources = [repo.path];
    const purpose = repo.summary.trim();
    if (purpose !== '') {
      projects.push({ area: 'project', topic, key: 'purpose', text: purpose, sources, at });
    }
    const active = now.getTime() - repoTime(repo) <= ACTIVE_DAYS * DAY_MS;
    projects.push({
      area: 'project',
      topic,
      key: 'status',
      text: active ? texts.activeStatus : texts.restingStatus,
      sources,
      at,
    });
    projects.push({ area: 'project', topic, key: 'files', text: repo.path, sources, at });
  }

  const keywordCounts = new Map<string, { count: number; paths: Set<string> }>();
  for (const repo of repos) {
    for (const raw of repo.keywords) {
      const keyword = raw.trim();
      if (keyword === '' || /^\d{4}-\d{2}-\d{2}$/.test(keyword)) continue;
      const entry = keywordCounts.get(keyword) ?? { count: 0, paths: new Set<string>() };
      entry.count += 1;
      entry.paths.add(repo.path);
      keywordCounts.set(keyword, entry);
    }
  }
  const tools = [...keywordCounts.entries()]
    .sort((left, right) => right[1].count - left[1].count)
    .slice(0, 5);
  if (tools.length > 0) {
    profile.push({
      area: 'profile',
      topic: 'other',
      key: 'tools',
      text: texts.tools(tools.map(([keyword]) => keyword)),
      sources: dedupe(tools.flatMap(([, entry]) => [...entry.paths])),
      at,
    });
  }

  const activeFolders = input.stats.find((line) => line.startsWith(ACTIVE_FOLDERS_LABEL));
  if (activeFolders !== undefined) {
    profile.push({
      area: 'profile',
      topic: 'other',
      key: 'folders',
      text: activeFolders,
      sources: ['folders'],
      at,
    });
  }

  return { profile, projects };
}
