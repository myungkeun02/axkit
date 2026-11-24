import { homedir } from 'node:os';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { SummaryCache } from './cache.js';
import type { ProfileOutcome, Scratch } from './scratch.js';
import { errorName, newScratch, stampOf } from './scratch.js';
import type { OnboardingConfig } from './config.js';
import { DEEP_LOCAL_FILES, folderStats, itemsFromDrive, itemsFromWalk } from './items.js';
import { DEEP_LIMITS, QUICK_LIMITS, listProjectItems } from './project-items.js';
import type { ScanItem, ScanItemSource } from './items.js';
import type { OnboardingTexts } from './locale.js';
import type { RunCounts, RunReason, RunStateStore, ScanPhase } from './state.js';
import type { SignalCollector } from './signals.js';
import { collectSignals } from './signals.js';
import { summarizeItem } from './summarize.js';
import { buildProfile, startReview } from './profile-phase.js';
import { displayOf, repoBody, richText, RICH_CHARS } from './bodies.js';
import { feedTalent } from './talent-feed.js';
import { countItem, factsOf, waitForModel } from './scratch.js';
import { offerSuggestions } from './suggest.js';

export type ProgressEvent =
  | { phase: ScanPhase; done: number; total: number }
  | { failed: 'model_unavailable' }
  | { finished: { counts: RunCounts; added: number; retired: number } };

export interface OnboardingRunnerDeps {
  ctx: PluginContext;
  config: OnboardingConfig;
  state: RunStateStore;
  cache: SummaryCache;
  texts: OnboardingTexts;
  collectors: readonly SignalCollector[];
  onProgress: (event: ProgressEvent) => void;
}

/** The deep first look summarizes this many items in one run; later daily runs only see what changed. */
const DEEP_SUMMARIES = 8_000;
const DEEP_DRIVE = 500;

/** The first-run scan: folders, Drive, connected signals, then one synthesized profile. */
export class OnboardingRunner {
  constructor(private readonly deps: OnboardingRunnerDeps) {}

  async run(reason: RunReason, signal: AbortSignal): Promise<void> {
    await this.deps.state.begin(reason, this.deps.ctx.clock.now().toISOString());
    const scratch: Scratch = newScratch(signal);

    try {
      await this.scanLocal(scratch);
      if (await this.pauseIfStopped(scratch)) return;
      await this.scanProjects(scratch);
      if (await this.pauseIfStopped(scratch)) return;
      await this.scanDrive(scratch);
      if (await this.pauseIfStopped(scratch)) return;
      await this.scanSignals(scratch);
      if (await this.pauseIfStopped(scratch)) return;

      if (waitForModel(scratch, this.deps.state.current.firstDoneAt !== undefined)) {
        await this.deps.cache.save();
        await this.deps.state.fail('model_unavailable', this.deps.ctx.clock.now().toISOString());
        this.deps.onProgress({ failed: 'model_unavailable' });
        return;
      }
      const outcome = await this.profile(scratch, reason);
      if (await this.pauseIfStopped(scratch)) return;

      if (scratch.localScanned) this.deps.cache.prune('local', scratch.seenLocal);
      if (scratch.driveScanned) this.deps.cache.prune('drive', scratch.seenDrive);
      if (scratch.projectScanned) this.deps.cache.prune('project', scratch.seenProject);
      await this.deps.cache.save();

      await this.deps.state.finish(this.deps.ctx.clock.now().toISOString(), scratch.counts, outcome.first);
      this.deps.onProgress({
        finished: { counts: { ...scratch.counts }, added: outcome.added, retired: outcome.retired },
      });
    } catch (error) {
      if (scratch.signal.aborted) {
        await this.deps.state.pause();
        return;
      }
      const name = errorName(error);
      this.deps.ctx.log.error('onboarding: the run failed', { error: name });
      await this.deps.state.fail(name, this.deps.ctx.clock.now().toISOString());
    }
  }

  private async pauseIfStopped(scratch: Scratch): Promise<boolean> {
    if (!scratch.signal.aborted) return false;
    await this.deps.state.pause();
    return true;
  }

  private async scanLocal(scratch: Scratch): Promise<void> {
    const phase: ScanPhase = 'local';
    await this.deps.state.setPhase(phase);
    const scanner = this.deps.ctx.tryUse(Contracts.folderScan);
    const folders = this.folders();
    if (scanner === undefined || folders.length === 0) {
      this.deps.onProgress({ phase, done: 0, total: 0 });
      return;
    }

    const scan = scanner.open(folders);
    const walk = await scan.walk(scratch.signal);
    scratch.walk = walk;
    scratch.localScanned = true;
    const items = itemsFromWalk(walk, this.deep ? DEEP_LOCAL_FILES : undefined).map((item) => {
      const project = this.deps.config.projects.find((picked) => item.id === picked.path || item.id.startsWith(`${picked.path}/`));
      return project === undefined ? item : { ...item, project: project.path };
    });
    const readBody = async (item: ScanItem): Promise<string | undefined> => {
      if (item.kind === 'repo') return repoBody(item, await scan.repo(item.id));
      if (!item.readable) return undefined;
      if (item.rich === true) return await richText(this.deps.ctx, scan, item.id, RICH_CHARS);
      return await scan.excerpt(item.id, this.deps.config.excerptBytes);
    };
    await this.processItems(scratch, phase, 'local', items, readBody);
  }

  private get deep(): boolean {
    return this.deps.config.depth === 'deep';
  }

  /** The chosen folders plus every picked project, so a project known only from its sessions is read too. */
  private folders(): string[] {
    const all = [...this.deps.config.folders];
    for (const project of this.deps.config.projects) if (!all.includes(project.path)) all.push(project.path);
    return all;
  }

  /** Each picked project's tracked documents and its Claude Code / Codex sessions. */
  private async scanProjects(scratch: Scratch): Promise<void> {
    const phase: ScanPhase = 'projects';
    await this.deps.state.setPhase(phase);
    const scanner = this.deps.ctx.tryUse(Contracts.folderScan);
    const picked = this.deps.config.projects;
    if (scanner === undefined || picked.length === 0) {
      this.deps.onProgress({ phase, done: 0, total: 0 });
      return;
    }
    const reader = this.deps.config.sessions ? this.deps.ctx.tryUse(Contracts.agentSessions) : undefined;
    const listed = await listProjectItems(picked, {
      scan: scanner.open(this.folders()),
      ...(reader !== undefined ? { sessions: reader } : {}),
      limits: this.deep ? DEEP_LIMITS : QUICK_LIMITS,
      signal: scratch.signal,
      log: this.deps.ctx.log,
    });
    if (listed === undefined) return;
    scratch.projectScanned = true;
    const { items, read } = listed;
    await this.processItems(scratch, phase, 'project', items, read);
  }

  private async scanDrive(scratch: Scratch): Promise<void> {
    const phase: ScanPhase = 'drive';
    await this.deps.state.setPhase(phase);
    const drive = this.deps.ctx.tryUse(Contracts.filesDrive);
    if (!this.deps.config.drive || drive?.recent === undefined || this.deps.config.driveLimit <= 0) {
      this.deps.onProgress({ phase, done: 0, total: 0 });
      return;
    }

    const entries = await drive.recent({ limit: this.deep ? Math.max(this.deps.config.driveLimit, DEEP_DRIVE) : this.deps.config.driveLimit });
    scratch.driveScanned = true;
    const items = itemsFromDrive(entries);
    const readBody = async (item: ScanItem): Promise<string | undefined> =>
      item.readable ? await drive.readText(item.id, this.deps.config.excerptBytes) : undefined;
    await this.processItems(scratch, phase, 'drive', items, readBody);
  }

  private async scanSignals(scratch: Scratch): Promise<void> {
    const phase: ScanPhase = 'signals';
    await this.deps.state.setPhase(phase);
    if (!this.deps.config.signals) {
      this.deps.onProgress({ phase, done: 0, total: 0 });
      return;
    }
    scratch.signals = await collectSignals(this.deps.collectors, this.deps.ctx, this.deps.ctx.clock.now(), this.deps.ctx.log);
    scratch.counts.signals = scratch.signals.length;
    await this.deps.state.setCounts(scratch.counts);
    this.deps.onProgress({ phase, done: scratch.signals.length, total: scratch.signals.length });
  }

  private async processItems(
    scratch: Scratch,
    phase: ScanPhase,
    source: ScanItemSource,
    items: readonly ScanItem[],
    readBody: (item: ScanItem) => Promise<string | undefined>,
  ): Promise<void> {
    const total = items.length;
    this.deps.onProgress({ phase, done: 0, total });
    let step = 0;
    for (let index = 0; index < items.length; index += 1) {
      if (scratch.signal.aborted) return;
      const item = items[index];
      if (item === undefined) continue;
      await this.processItem(scratch, source, item, readBody);
      const done = index + 1;
      // One event per percent at most: the live bar moves smoothly, a huge folder does not flood listeners.
      const reached = total === 0 ? 0 : Math.floor((done / total) * 100);
      if (reached > step) {
        step = reached;
        this.deps.onProgress({ phase, done, total });
      }
    }
  }

  private async processItem(
    scratch: Scratch,
    source: ScanItemSource,
    item: ScanItem,
    readBody: (item: ScanItem) => Promise<string | undefined>,
  ): Promise<void> {
    if (source === 'local') scratch.seenLocal.add(item.id);
    else if (source === 'project') scratch.seenProject.add(item.id);
    else scratch.seenDrive.add(item.id);
    countItem(scratch, item);

    const stamp = stampOf(item);
    const cached = this.deps.cache.get(source, item.id);
    if (cached !== undefined && cached.stamp === stamp) {
      scratch.summaries.set(`${source}:${item.id}`, item.project !== undefined ? { ...cached, project: item.project } : cached);
      await this.persist(scratch);
      await feedTalent(this.deps.ctx, item, cached.docType, undefined, readBody);
      return;
    }

    const cap = this.deep ? Math.max(this.deps.config.maxSummariesPerRun, DEEP_SUMMARIES) : this.deps.config.maxSummariesPerRun;
    const skipModel = scratch.modelStopped || scratch.modelCalls >= cap;
    let summary = item.title;
    let keywords: string[] = [];
    let docType: string | undefined;
    let read: string | undefined;
    let storedStamp = stamp;

    if (item.readable && !skipModel) {
      let body: string | undefined;
      try {
        body = await readBody(item);
      } catch (error) {
        this.deps.ctx.log.warn('onboarding: an item could not be read', {
          kind: item.kind,
          error: errorName(error),
        });
        body = undefined;
        // A failed read is kept without the stamp, like a model-stopped summary, so a later run reads it again.
        storedStamp = '';
      }
      read = body;
      if (body === undefined) {
        summary = item.title;
      } else {
        scratch.modelCalls += 1;
        scratch.counts.summarized += 1;
        const result = await summarizeItem(
          { llm: this.deps.ctx.llm, log: this.deps.ctx.log },
          { kind: item.kind, title: item.title, path: item.path },
          body,
          this.deps.texts,
        );
        summary = result.summary;
        keywords = result.keywords;
        docType = result.docType;
        if (result.modelStopped) {
          scratch.modelStopped = true;
          scratch.modelBroken ||= result.modelBroken === true;
          storedStamp = '';
        } else {
          scratch.modelOk += 1;
        }
      }
    } else if (item.readable) {
      // Over the per-run cap: keep metadata only, without the stamp, so a later run summarizes it.
      storedStamp = '';
    }

    this.deps.cache.put(source, item.id, {
      stamp: storedStamp,
      kind: item.kind,
      path: item.path,
      title: item.title,
      modifiedAt: item.modifiedAt,
      summary,
      keywords,
      ...(item.project !== undefined ? { project: item.project } : {}),
      ...(docType !== undefined ? { docType } : {}),
    });
    await feedTalent(this.deps.ctx, item, docType, read, readBody);
    const record = this.deps.cache.get(source, item.id);
    if (record !== undefined) scratch.summaries.set(`${source}:${item.id}`, record);
    await this.persist(scratch);
  }

  private async persist(scratch: Scratch): Promise<void> {
    await this.deps.cache.save();
    await this.deps.state.setCounts(scratch.counts);
  }

  private async profile(scratch: Scratch, reason: RunReason): Promise<ProfileOutcome> {
    const phase: ScanPhase = 'profile';
    await this.deps.state.setPhase(phase);
    this.deps.onProgress({ phase, done: 0, total: 1 });
    const now = this.deps.ctx.clock.now();
    const stats = scratch.walk === undefined ? [] : folderStats(scratch.walk, now);
    const outcome = await buildProfile({
      ctx: this.deps.ctx,
      state: this.deps.state,
      texts: this.deps.texts,
      input: { summaries: [...scratch.summaries.values()], stats, signals: scratch.signals },
      daily: reason === 'daily',
      now,
      picked: this.deps.config.projects,
      display: (path) => displayOf(path, homedir()),
      onProject: (done, total) => {
        this.deps.onProgress({ phase, done, total: total + 1 });
      },
    });
    this.deps.onProgress({ phase, done: 1, total: 1 });

    const first = this.deps.state.current.firstDoneAt === undefined;
    if (first && outcome.saved) {
      await startReview(this.deps.ctx, this.deps.state, this.deps.texts);
      // Cards wait for the owner's answer; the run does not.
      void offerSuggestions(this.deps.ctx, factsOf(scratch), this.deps.ctx.assistant.language !== 'en').catch(() => undefined);
    }
    return { added: outcome.added, retired: outcome.retired, first };
  }

}
