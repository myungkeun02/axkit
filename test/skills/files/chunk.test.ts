import { describe, expect, it } from 'vitest';
import { CHUNK_CHARS, MAX_CHUNKS_PER_FILE, chunkText } from '../../../src/skills/files/chunk.js';

describe('chunkText', () => {
  it('returns nothing for blank text and normalizes line endings', () => {
    expect(chunkText('  \n\n ')).toEqual([]);
    expect(chunkText('first\r\n\r\nsecond')).toEqual(['first\n\nsecond']);
  });

  it('merges small paragraphs into one chunk and splits when the next one would overflow', () => {
    const first = 'a'.repeat(800);
    const second = 'b'.repeat(800);
    expect(chunkText(`${first}\n\n${second}`)).toEqual([first, second]);
    expect(chunkText(`${first}\n\nshort`)).toEqual([`${first}\n\nshort`]);
  });

  it('hard-splits a paragraph that is longer than a chunk', () => {
    const chunks = chunkText('c'.repeat(CHUNK_CHARS * 2 + 40));
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= CHUNK_CHARS)).toBe(true);
    expect(chunks.join('')).toBe('c'.repeat(CHUNK_CHARS * 2 + 40));
  });

  it('keeps at most twenty chunks per file', () => {
    const paragraphs = Array.from({ length: 30 }, (_, index) => `${index}-${'d'.repeat(1_600)}`);
    const chunks = chunkText(paragraphs.join('\n\n'));

    expect(chunks).toHaveLength(MAX_CHUNKS_PER_FILE);
    expect(chunks[0]?.startsWith('0-')).toBe(true);
  });
});
