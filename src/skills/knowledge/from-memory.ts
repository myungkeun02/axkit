import type { Fact } from '../../core/contracts/memory.js';
import type { KnowledgeLine } from '../../core/contracts/knowledge.js';
import { keywordArea } from './areas.js';

function sourceOf(fact: Fact): string {
  const base = `memory:${fact.source.kind}`;
  return fact.source.ref === undefined ? base : `${base}:${fact.source.ref}`;
}

/** Interview answers the owner already reviewed are not re-imported: the review answer is the better record. */
function isReviewedAnswer(fact: Fact): boolean {
  return fact.source.kind === 'interview' && fact.source.ref?.startsWith('review:') === true;
}

export function memoryLines(
  facts: readonly Fact[],
  areas: ReadonlyMap<string, string>,
  minStrength: number,
  ownerLabel: string,
): KnowledgeLine[] {
  return facts
    .filter((fact) => fact.strength >= minStrength && !isReviewedAnswer(fact))
    .map((fact) => ({
      area: areas.get(fact.id) ?? keywordArea(fact.text),
      topic: fact.subject === 'owner' ? ownerLabel : fact.subject,
      key: fact.id,
      text: fact.text,
      sources: [sourceOf(fact)],
      at: fact.at,
    }));
}
