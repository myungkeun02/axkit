const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const HANGUL = /[가-힣]/;

/**
 * Lower-case words of two or more letters or digits. Hangul words also yield their first two characters,
 * so "회의록" and "회의록에서" meet in the middle ("회의").
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const word of text.normalize('NFC').toLowerCase().split(WORD_SPLIT)) {
    if (word.length < 2) continue;
    tokens.push(word);
    if (word.length >= 3 && HANGUL.test(word)) tokens.push(word.slice(0, 2));
  }
  return tokens;
}

/** Distinct tokens in first-seen order. */
export function tokenSet(text: string): string[] {
  return [...new Set(tokenize(text))];
}
