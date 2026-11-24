import { homedir } from 'node:os';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { z } from 'zod';
import type { PickedProject, ProjectCandidate } from './projects.js';
import { discoverProjects } from './projects.js';

const PICKED_KEY = 'projects.picked';
const FRESH_MS = 10 * 60_000;

const PickedSchema = z.array(z.object({ path: z.string().min(1), name: z.string().min(1).max(80), company: z.string().min(1).max(80) })).max(200);

/** The projects the owner picked in the app; they replace the setup choice once saved. */
export async function readPicked(ctx: PluginContext): Promise<PickedProject[] | undefined> {
  const parsed = PickedSchema.safeParse(await ctx.kv.get<unknown>(PICKED_KEY));
  return parsed.success ? parsed.data : undefined;
}

export async function savePicked(ctx: PluginContext, picked: readonly PickedProject[]): Promise<void> {
  await ctx.kv.set(PICKED_KEY, picked);
}

/** Finds projects with the running server's connectors; the list is kept for a few minutes. */
export class ProjectFinder {
  private cached?: { at: number; list: ProjectCandidate[] };

  constructor(
    private readonly ctx: PluginContext,
    private readonly folders: () => readonly string[],
  ) {}

  async candidates(refresh = false): Promise<ProjectCandidate[]> {
    const now = this.ctx.clock.now().getTime();
    if (!refresh && this.cached !== undefined && now - this.cached.at < FRESH_MS) return this.cached.list;
    const scanner = this.ctx.tryUse(Contracts.folderScan);
    const reader = this.ctx.tryUse(Contracts.agentSessions);
    const folders = this.folders();
    const walk = scanner !== undefined && folders.length > 0 ? await scanner.open(folders).walk() : { files: [], repos: [], truncated: false };
    const sessions = reader === undefined ? [] : await reader.list().catch(() => []);
    const locate = scanner?.locate?.bind(scanner);
    const list = await discoverProjects({
      repos: walk.repos,
      files: walk.files,
      sessions,
      locate: async (path) => (locate === undefined ? undefined : await locate(path)),
      home: homedir(),
      personal: this.ctx.assistant.language === 'en' ? 'Personal' : '개인',
    });
    this.cached = { at: now, list };
    return list;
  }
}
