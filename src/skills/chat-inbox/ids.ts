import { createHash } from 'node:crypto';

/** Short stable id for a preview ref, so a re-read of the same line cannot create a second suggestion. */
export function shortId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 10);
}
