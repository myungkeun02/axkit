import type { FolderWalk } from '../../core/contracts/scan.js';
import type { CachedSummary } from './cache.js';
import type { ScanItem } from './items.js';
import type { RunCounts } from './state.js';
import { zeroCounts } from './state.js';
import type { SignalLine } from './signals.js';
import type { SuggestFacts } from './suggest-catalog.js';

/** What one run carries between its phases. */
export interface Scratch {
  signal: AbortSignal;
  counts: RunCounts;
  modelCalls: number;
  modelStopped: boolean;
  /** Summaries the model actually wrote this run. */
  modelOk: number;
  /** The configured model could not run (not merely absent). */
  modelBroken: boolean;
  summaries: Map<string, CachedSummary>;
  seenLocal: Set<string>;
  seenDrive: Set<string>;
  seenProject: Set<string>;
  localScanned: boolean;
  driveScanned: boolean;
  projectScanned: boolean;
  walk?: FolderWalk;
  signals: SignalLine[];
}

export interface ProfileOutcome {
  added: number;
  retired: number;
  first: boolean;
}

export function newScratch(signal: AbortSignal): Scratch {
  return {
    signal,
    counts: zeroCounts(),
    modelCalls: 0,
    modelStopped: false,
    modelOk: 0,
    modelBroken: false,
    summaries: new Map(),
    seenLocal: new Set(),
    seenDrive: new Set(),
    seenProject: new Set(),
    localScanned: false,
    driveScanned: false,
    projectScanned: false,
    signals: [],
  };
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/** Changes when the item does; a cached summary with the same stamp is reused. */
export function stampOf(item: ScanItem): string {
  return `${item.modifiedAt}|${item.size}`;
}

/** What the run saw, in numbers only, for the feature suggestions. */
export function factsOf(scratch: Scratch): SuggestFacts {
  const docTypes: Record<string, number> = {};
  for (const summary of scratch.summaries.values()) {
    if (summary.docType === undefined) continue;
    docTypes[summary.docType] = (docTypes[summary.docType] ?? 0) + 1;
  }
  return {
    docTypes,
    repos: scratch.counts.repos,
    sessions: scratch.counts.sessions,
    driveFiles: scratch.counts.drive,
    mail: scratch.signals.filter((line) => line.source === 'mail').length,
    calendar: scratch.signals.filter((line) => line.source === 'calendar').length,
  };
}

/**
 * A first look whose configured AI never ran (a missing CLI, a bad key) would only write a profile from file names and
 * call itself done; it waits instead. Running with no AI set up at all is a choice and still gets the code profile.
 */
export function waitForModel(scratch: Scratch, firstDone: boolean): boolean {
  return !firstDone && scratch.modelBroken && scratch.modelOk === 0;
}

export function countItem(scratch: Scratch, item: ScanItem): void {
  if (item.kind === 'doc') scratch.counts.docs += 1;
  else if (item.kind === 'session') scratch.counts.sessions += 1;
  else if (item.source === 'drive') scratch.counts.drive += 1;
  else if (item.kind === 'repo') scratch.counts.repos += 1;
  else scratch.counts.files += 1;
}
