const NEAR_SAME = 0.8;

/** Word sets that are almost the same (Dice ≥ 0.8, at least three words each). */
export function nearSame(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size < 3 || right.size < 3) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size) >= NEAR_SAME;
}
