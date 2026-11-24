import { describe, expect, it } from 'vitest';
import { splitForDiscord, toOutbound } from '../../../src/channels/discord/render.js';

describe('splitForDiscord', () => {
  it('returns one chunk when the text fits', () => {
    expect(splitForDiscord('hello')).toEqual(['hello']);
  });

  it('hard-splits a long line at the limit', () => {
    const chunks = splitForDiscord('a'.repeat(2500), 2000);
    expect(chunks).toEqual(['a'.repeat(2000), 'a'.repeat(500)]);
  });

  it('prefers a newline boundary', () => {
    const line = 'x'.repeat(1500);
    const text = `${line}\n${'y'.repeat(1000)}`;
    const chunks = splitForDiscord(text, 2000);
    expect(chunks[0]).toBe(`${line}\n`);
    expect(chunks[1]).toBe('y'.repeat(1000));
  });

  it('keeps an empty message as one empty chunk', () => {
    expect(splitForDiscord('')).toEqual(['']);
  });
});

describe('toOutbound', () => {
  it('puts buttons only on the last chunk', () => {
    const outbound = toOutbound(
      { text: 'z'.repeat(2500), choices: [{ id: 'a', label: 'A' }] },
      'choice',
    );
    expect(outbound).toHaveLength(2);
    expect(outbound[0]?.buttons).toBeUndefined();
    expect(outbound[1]?.buttons).toEqual([{ customId: 'choice:a', label: 'A' }]);
  });

  it('truncates custom ids and labels', () => {
    const longId = 'i'.repeat(120);
    const longLabel = 'L'.repeat(120);
    const [outbound] = toOutbound({ text: 'pick', choices: [{ id: longId, label: longLabel }] }, 'choice');
    const button = outbound?.buttons?.[0];
    expect(button?.customId).toHaveLength(100);
    expect(button?.label).toHaveLength(80);
  });

  it('has no buttons when there are no choices', () => {
    expect(toOutbound({ text: 'plain' }, 'choice')).toEqual([{ content: 'plain' }]);
  });
});
