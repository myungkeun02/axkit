import type { PluginContext } from '../../core/plugin/types.js';
import type { SummaryCache } from './cache.js';
import type { ScanItem, ScanItemSource } from './items.js';
import type { OnboardingTexts } from './locale.js';
import type { RunStateStore } from './state.js';
import type { Scratch } from './scratch.js';
import type { PersonMention } from './mentions.js';
import { countItem, errorName, stampOf } from './scratch.js';
import { summarizeItem } from './summarize.js';
import { feedTalent } from './talent-feed.js';

export interface ItemDeps {
  ctx: PluginContext;
  cache: SummaryCache;
  state: RunStateStore;
  texts: OnboardingTexts;
  /** Model calls this run may make; the rest waits for the next run (kept without a stamp). */
  cap: number;
}

/** How many files are read and summarized at once. */
export const CONCURRENCY = 4;
/** The cache is one large value: it is written every this many items or seconds, and at the end of each phase. */
const SAVE_EVERY = 50;
const SAVE_MS = 15_000;

export async function persist(deps: ItemDeps, scratch: Scratch, force = false): Promise<void> {
  scratch.unsaved += 1;
  if (!force && scratch.unsaved < SAVE_EVERY && Date.now() - scratch.savedAt < SAVE_MS) return;
  scratch.unsaved = 0;
  scratch.savedAt = Date.now();
  await deps.cache.save();
  await deps.state.setCounts(scratch.counts);
}

/**
 * Runs `work` over the items a few at a time, in order of the list; stops taking new ones once aborted. Until `ready`
 * says the model has answered (or stopped), items go one by one, so a missing model costs one failed call, not four.
 */
export async function eachItem(items: readonly ScanItem[], signal: AbortSignal, work: (item: ScanItem, index: number) => Promise<void>, ready: () => boolean = () => true): Promise<void> {
  let next = 0;
  while (!ready() && !signal.aborted && next < items.length) {
    const item = items[next];
    next += 1;
    if (item !== undefined) await work(item, next - 1);
  }
  const lane = async (): Promise<void> => {
    while (!signal.aborted) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await work(item, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => lane()));
}

/** One file, repository, document or session: reuse the cached summary when it has not changed, else read and summarize. */
export async function processItem(
  deps: ItemDeps,
  scratch: Scratch,
  source: ScanItemSource,
  item: ScanItem,
  readBody: (item: ScanItem) => Promise<string | undefined>,
): Promise<void> {
  const { ctx, cache } = deps;
  if (source === 'local') scratch.seenLocal.add(item.id);
  else if (source === 'project') scratch.seenProject.add(item.id);
  else scratch.seenDrive.add(item.id);
  countItem(scratch, item);

  const stamp = stampOf(item);
  const cached = cache.get(source, item.id);
  if (cached !== undefined && cached.stamp === stamp) {
    scratch.summaries.set(`${source}:${item.id}`, item.project !== undefined ? { ...cached, project: item.project } : cached);
    await persist(deps, scratch);
    await feedTalent(ctx, item, cached.docType, undefined, readBody);
    return;
  }

  const skipModel = scratch.modelStopped || scratch.modelCalls >= deps.cap;
  // An older summary stays until a new one is written: a run out of budget never wipes what an earlier run read.
  let summary = cached?.summary ?? item.title;
  let keywords: string[] = cached?.keywords ?? [];
  let docType: string | undefined = cached?.docType;
  let people = cached?.people as PersonMention[] | undefined;
  let read: string | undefined;
  let storedStamp = stamp;

  if (item.readable && !skipModel) {
    // The slot is taken before the read, so parallel lanes never go past the run's budget.
    scratch.modelCalls += 1;
    let body: string | undefined;
    try {
      body = await readBody(item);
    } catch (error) {
      ctx.log.warn('onboarding: an item could not be read', { kind: item.kind, error: errorName(error) });
      body = undefined;
      // A failed read is kept without the stamp, like a model-stopped summary, so a later run reads it again.
      storedStamp = '';
    }
    read = body;
    if (body === undefined) scratch.modelCalls -= 1;
    else {
      scratch.counts.summarized += 1;
      const result = await summarizeItem({ llm: ctx.llm, log: ctx.log }, { kind: item.kind, title: item.title, path: item.path }, body, deps.texts);
      summary = result.summary;
      keywords = result.keywords;
      docType = result.docType;
      people = result.people;
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
  if (item.readable && storedStamp === '') scratch.pending += 1;

  cache.put(source, item.id, {
    stamp: storedStamp,
    kind: item.kind,
    path: item.path,
    title: item.title,
    modifiedAt: item.modifiedAt,
    summary,
    keywords,
    ...(item.project !== undefined ? { project: item.project } : {}),
    ...(docType !== undefined ? { docType } : {}),
    ...(people !== undefined && people.length > 0 ? { people } : {}),
  });
  await feedTalent(ctx, item, docType, read, readBody);
  const record = cache.get(source, item.id);
  if (record !== undefined) scratch.summaries.set(`${source}:${item.id}`, record);
  await persist(deps, scratch);
}
