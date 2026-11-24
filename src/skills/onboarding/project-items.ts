import type { FolderScan } from '../../core/contracts/scan.js';
import type { AgentSession, AgentSessionReader } from '../../core/contracts/sessions.js';
import type { Logger } from '../../core/log/types.js';
import type { ScanItem } from './items.js';
import type { PickedProject } from './projects.js';
import { sessionsOf } from './projects.js';

/** How much the deep first look reads per picked project. */
export const DEEP_LIMITS = {
  docsPerProject: 40,
  sessionsPerProject: 40,
  /** Characters of one session sent to the summary model (start and end kept). */
  transcriptChars: 12_000,
  /** Characters of one project document sent to the summary model. */
  docBytes: 8_000,
} as const;

export const QUICK_LIMITS = {
  docsPerProject: 8,
  sessionsPerProject: 8,
  transcriptChars: 6_000,
  docBytes: 4_000,
} as const;

export type ProjectLimits = { readonly [K in keyof typeof DEEP_LIMITS]: number };

export interface ProjectItemsDeps {
  scan: FolderScan;
  sessions?: AgentSessionReader;
  /** All sessions on this computer, read once per run. */
  allSessions: readonly AgentSession[];
  limits: ProjectLimits;
  signal: AbortSignal;
}

function sessionTitle(session: AgentSession): string {
  const label = session.tool === 'claude' ? 'Claude' : 'Codex';
  const what = session.title ?? session.firstPrompt ?? session.id;
  return `${label}: ${what}`.slice(0, 160);
}

/** Documents and coding sessions of one picked project, newest sessions first. */
export async function projectItems(project: PickedProject, deps: ProjectItemsDeps): Promise<ScanItem[]> {
  const items: ScanItem[] = [];
  if (deps.scan.repoDocs !== undefined) {
    try {
      const docs = await deps.scan.repoDocs(project.path, deps.limits.docsPerProject);
      for (const doc of docs) {
        items.push({ source: 'project', kind: 'doc', id: doc.id, path: doc.path, title: doc.name, modifiedAt: doc.modifiedAt, size: doc.size, readable: true, project: project.path });
      }
    } catch {
      // A project that is not a git repository has no tracked documents; its sessions still count.
    }
  }
  if (deps.sessions !== undefined) {
    const own = sessionsOf(project, deps.allSessions)
      .filter((session) => session.turns > 0)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, deps.limits.sessionsPerProject);
    for (const session of own) {
      items.push({
        source: 'project',
        kind: 'session',
        id: `${session.tool}:${session.id}`,
        path: `${session.tool === 'claude' ? 'Claude Code' : 'Codex'} · ${project.name} · ${session.startedAt.slice(0, 10)}`,
        title: sessionTitle(session),
        modifiedAt: session.updatedAt,
        // The turn count stands in for size, so a session that grew is summarized again.
        size: session.turns,
        readable: true,
        project: project.path,
      });
    }
  }
  return items;
}

/** Reads one project item's text for the summary model. */
export async function readProjectItem(item: ScanItem, deps: Pick<ProjectItemsDeps, 'scan' | 'sessions' | 'limits'>): Promise<string | undefined> {
  if (item.kind === 'doc') return await deps.scan.excerpt(item.id, deps.limits.docBytes);
  if (item.kind !== 'session' || deps.sessions === undefined) return undefined;
  const split = item.id.indexOf(':');
  const tool = item.id.slice(0, split);
  if (tool !== 'claude' && tool !== 'codex') return undefined;
  const text = await deps.sessions.transcript({ tool, id: item.id.slice(split + 1) }, deps.limits.transcriptChars);
  return text === undefined ? undefined : `${item.title}\n${text}`;
}

export interface ListDeps {
  scan: FolderScan;
  sessions?: AgentSessionReader;
  limits: ProjectLimits;
  signal: AbortSignal;
  log: Logger;
}

/** Every picked project's items and how to read them; undefined when the run was stopped meanwhile. */
export async function listProjectItems(
  picked: readonly PickedProject[],
  deps: ListDeps,
): Promise<{ items: ScanItem[]; read: (item: ScanItem) => Promise<string | undefined> } | undefined> {
  let allSessions: readonly AgentSession[] = [];
  if (deps.sessions !== undefined) {
    try {
      allSessions = await deps.sessions.list(deps.signal);
    } catch (error) {
      if (deps.signal.aborted) return undefined;
      deps.log.warn('onboarding: coding sessions could not be listed', { error: error instanceof Error ? error.name : 'unknown' });
    }
  }
  const items: ScanItem[] = [];
  for (const project of picked) {
    if (deps.signal.aborted) return undefined;
    items.push(...(await projectItems(project, { ...deps, allSessions })));
  }
  return { items, read: (item) => readProjectItem(item, deps) };
}
