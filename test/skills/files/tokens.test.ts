import { describe, expect, it } from 'vitest';
import { tokenize, tokenSet } from '../../../src/skills/files/tokens.js';

describe('tokenize', () => {
  it('lower-cases words and drops non letters and digits', () => {
    expect(tokenize('Hello, World!! 3 items')).toEqual(['hello', 'world', 'items']);
    expect(tokenize('a be 7 12')).toEqual(['be', '12']);
  });

  it('adds two-character Hangul prefixes so inflected words match', () => {
    expect(tokenSet('회의록')).toEqual(['회의록', '회의']);
    expect(tokenSet('회의록에서')).toEqual(['회의록에서', '회의']);

    const document = new Set(tokenize('회의록에서 결정했어요'));
    expect(tokenize('회의록').some((token) => document.has(token))).toBe(true);
  });

  it('does not add prefixes for short Hangul words or Latin words', () => {
    expect(tokenSet('회의')).toEqual(['회의']);
    expect(tokenSet('meeting')).toEqual(['meeting']);
  });
});
