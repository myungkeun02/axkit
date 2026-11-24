import { maskSecrets } from './mask.js';
import type { StoredFact } from './facts.js';

export interface ReconcileChanges {
  merges: readonly { keep: string; drop: readonly string[]; text?: string }[];
  replaced: readonly { old: string; by: string }[];
}

/**
 * Memory cleanup's verdict on a copy of the facts: `drop` facts merge into `keep` (worded `text`), and `replaced` facts
 * end because a newer one says otherwise. Facts from the interview or the owner's own words are never ended or
 * reworded by a chat-learned one, and an older fact never replaces a newer one.
 */
export function applyReconcile(input: readonly StoredFact[], changes: ReconcileChanges, iso: string): { facts: StoredFact[]; merged: number; replaced: number } {
  let facts = input.map((fact) => ({ ...fact }));
  const get = (id: string): StoredFact | undefined => facts.find((fact) => fact.id === id);
  const strong = (fact: StoredFact | undefined): boolean => fact?.source.kind === 'interview' || fact?.source.kind === 'manual';
  let merged = 0;
  let replaced = 0;
  for (const merge of changes.merges) {
    const keep = get(merge.keep);
    if (keep === undefined) continue;
    for (const id of merge.drop) {
      const drop = get(id);
      if (drop === undefined || drop.id === keep.id || drop.subject !== keep.subject) continue;
      if (strong(drop) && !strong(keep)) continue;
      if (drop.confirmedAt > keep.confirmedAt) keep.confirmedAt = drop.confirmedAt;
      keep.halfLifeDays = Math.max(keep.halfLifeDays, drop.halfLifeDays);
      facts = facts.filter((fact) => fact.id !== drop.id);
      merged += 1;
    }
    const text = merge.text?.trim();
    if (text !== undefined && text.length > 0 && !strong(keep)) keep.text = maskSecrets(text).slice(0, 300);
  }
  for (const change of changes.replaced) {
    const old = get(change.old);
    const by = get(change.by);
    if (old === undefined || by === undefined || old.id === by.id || old.subject !== by.subject || old.expiredAt !== undefined) continue;
    if (strong(old) && !strong(by)) continue;
    if (by.learnedAt < old.learnedAt) continue;
    old.expiredAt = iso;
    old.expiredReason = 'replaced';
    old.replacedBy = by.id;
    replaced += 1;
  }
  return { facts, merged, replaced };
}
