import { z } from 'zod';
import type { AppView } from '../../core/contracts/device-api.js';
import { ViewInputError, ownerInputError } from '../../core/contracts/device-api.js';
import type { ProjectFinder } from './discover.js';
import type { PickedProject, ProjectCandidate } from './projects.js';
import { byCompany } from './projects.js';
import type { RunState } from './state.js';

const saveSchema = z.object({
  projects: z
    .array(
      z.object({
        path: z.string().min(1).max(1_000),
        name: z.string().trim().min(1).max(80),
        company: z.string().trim().min(1).max(80),
        remote: z.string().trim().max(200).optional(),
      }),
    )
    .max(200),
  /** Read the newly picked projects now instead of at the next daily run. */
  rescan: z.boolean().optional(),
});

export interface ProjectsViewDeps {
  finder: ProjectFinder;
  picked: () => readonly PickedProject[];
  save: (picked: PickedProject[]) => Promise<void>;
  state: () => RunState;
  running: () => boolean;
  start: () => 'started' | 'running';
  korean: boolean;
}

interface Row extends ProjectCandidate {
  picked: boolean;
}

function rows(candidates: readonly ProjectCandidate[], picked: readonly PickedProject[]): Row[] {
  const chosen = new Map(picked.map((item) => [item.path, item]));
  const out: Row[] = candidates.map((candidate) => {
    const mine = chosen.get(candidate.path);
    return { ...candidate, name: mine?.name ?? candidate.name, company: mine?.company ?? candidate.company, picked: mine !== undefined };
  });
  // A picked project whose folder no longer shows up stays listed, so it can be unpicked.
  for (const item of picked) {
    if (candidates.some((candidate) => candidate.path === item.path)) continue;
    out.push({ path: item.path, display: item.path, name: item.name, company: item.company, lastActive: '', claude: 0, codex: 0, inFolders: false, picked: true });
  }
  return out;
}

/**
 * View "projects" (§23): the company → project list the first look found (folders, Claude Code and Codex sessions),
 * which ones the owner picked, and saving a new pick. Only folders it found (or picked before) can be picked, so the
 * app can never point the scan at an arbitrary path.
 */
export function projectsView(deps: ProjectsViewDeps): AppView {
  const read = async (refresh: boolean): Promise<Record<string, unknown>> => {
    const list = rows(await deps.finder.candidates(refresh), deps.picked());
    const state = deps.state();
    return {
      companies: byCompany(list).map((company) => ({
        name: company,
        projects: list
          .filter((row) => row.company === company)
          .map((row) => ({
            path: row.path,
            display: row.display,
            name: row.name,
            company: row.company,
            ...(row.remote !== undefined ? { remote: row.remote } : {}),
            ...(row.lastActive !== '' ? { lastActive: row.lastActive } : {}),
            claude: row.claude,
            codex: row.codex,
            picked: row.picked,
          })),
      })),
      picked: list.filter((row) => row.picked).length,
      scan: {
        status: deps.running() ? 'running' : state.status,
        phase: state.phase,
        counts: state.counts,
        ...(state.finishedAt !== undefined ? { finishedAt: state.finishedAt } : {}),
      },
    };
  };
  return {
    name: 'projects',
    version: 1,
    read: async (query) => await read(query.get('refresh') === '1'),
    actions: {
      async save(body) {
        const parsed = saveSchema.safeParse(body);
        if (!parsed.success) throw new ViewInputError('shape');
        const known = new Set([...(await deps.finder.candidates()).map((candidate) => candidate.path), ...deps.picked().map((item) => item.path)]);
        const unknown = parsed.data.projects.find((item) => !known.has(item.path));
        if (unknown !== undefined) throw ownerInputError(deps.korean ? '찾은 목록에 없는 폴더예요. 목록을 새로 고친 뒤 골라 주세요.' : 'That folder is not in the list. Refresh and pick again.');
        // the app sends path, name and company; the git origin comes from what was found
        const found = new Map((await deps.finder.candidates()).map((candidate) => [candidate.path, candidate.remote]));
        const unique = [...new Map(parsed.data.projects.map((item) => [item.path, { ...item, ...(item.remote === undefined && found.get(item.path) !== undefined ? { remote: found.get(item.path) } : {}) }])).values()];
        await deps.save(unique);
        const started = parsed.data.rescan === true ? deps.start() : undefined;
        return { saved: unique.length, ...(started !== undefined ? { scan: started } : {}) };
      },
      async refresh() {
        return await read(true);
      },
    },
  };
}
