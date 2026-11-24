const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
/** Every Hangul syllable block is base + initial*21*28 + medial*28 + final. */
const FINAL_COUNT = 28;

/** undefined means "not a Hangul syllable", so callers can pick their own fallback. */
export function hasBatchim(word: string): boolean | undefined {
  const last = [...word.trim()].at(-1);
  if (last === undefined) return undefined;
  const code = last.codePointAt(0);
  if (code === undefined || code < HANGUL_BASE || code > HANGUL_LAST) return undefined;
  return (code - HANGUL_BASE) % FINAL_COUNT !== 0;
}
