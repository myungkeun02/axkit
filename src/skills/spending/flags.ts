import type { SpendEntry } from '../../core/contracts/index.js';
import type { MonthPatterns } from './patterns.js';

export type FlagReason = 'unclassified' | 'duplicate' | 'unusual' | 'fx';

export interface FlaggedEntry {
  entry: SpendEntry;
  reason: FlagReason;
}

/**
 * Entries the owner may want to fix before the month closes. One entry appears once, with the first reason that
 * applies: unclassified, duplicate, unusual, then an FX estimate.
 */
export function flaggedEntries(entries: readonly SpendEntry[], patterns: MonthPatterns): FlaggedEntry[] {
  const duplicates = new Set<string>();
  for (const candidate of patterns.duplicates) {
    for (const entry of candidate.entries) duplicates.add(entry.id);
  }
  const unusual = new Set(patterns.unusual.map((candidate) => candidate.entry.id));

  const flags: FlaggedEntry[] = [];
  for (const entry of [...entries].sort((left, right) => left.at.localeCompare(right.at))) {
    if (entry.excluded === true) continue;
    if (entry.categorySource === 'none') flags.push({ entry, reason: 'unclassified' });
    else if (duplicates.has(entry.id)) flags.push({ entry, reason: 'duplicate' });
    else if (unusual.has(entry.id)) flags.push({ entry, reason: 'unusual' });
    else if (entry.fxEstimated === true) flags.push({ entry, reason: 'fx' });
  }
  return flags;
}
