import { describe, expect, it } from 'vitest';
import { detectChanges, tokensOf } from '../../../src/skills/tuning/detect.js';
import type { StoredFeedback, StoredVerdict } from '../../../src/skills/tuning/types.js';
import { DAY_MS, NOW } from './helpers.js';

function stored(
  domain: string,
  subject: string,
  verdict: StoredVerdict,
  daysAgo = 1,
  options: { correction?: string; label?: string } = {},
): StoredFeedback {
  return {
    domain,
    subject,
    verdict,
    at: new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString(),
    ...(options.correction !== undefined ? { correction: options.correction } : {}),
    ...(options.label !== undefined ? { label: options.label } : {}),
  };
}

function detect(feedback: readonly StoredFeedback[], existing: readonly { domain: string; subject: string; action: 'mute' | 'unmute' | 'set'; value?: string }[] = []) {
  return detectChanges({
    feedback,
    now: NOW,
    existing: existing.map((change) => ({ id: 'x', ...change })),
  });
}

describe('tokensOf', () => {
  it('splits on whitespace and punctuation, skipping short, numeric and stopword tokens', () => {
    expect(tokensOf('별빛 커피(Inc) 123 x')).toEqual(['별빛', '커피']);
  });

  it('keeps a two-letter word', () => {
    expect(tokensOf('AB')).toEqual(['ab']);
  });
});

describe('notice proposals', () => {
  it('mutes a notice kind rejected twice within 14 days', () => {
    const found = detect([
      stored('notice', 'chat.replies', 'rejected', 1),
      stored('notice', 'chat.replies', 'rejected', 5),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]?.id).toMatch(/^[0-9a-f]{8}$/);
    expect(found[0]?.change).toMatchObject({ domain: 'notice', subject: 'chat.replies', action: 'mute' });
    expect(found[0]?.reason).toEqual({ kind: 'notice', rejections: 2 });
  });

  it('needs two rejections', () => {
    expect(detect([stored('notice', 'chat.replies', 'rejected', 1)])).toEqual([]);
  });

  it('does not propose when the owner also accepted it', () => {
    const found = detect([
      stored('notice', 'chat.replies', 'rejected', 1),
      stored('notice', 'chat.replies', 'rejected', 5),
      stored('notice', 'chat.replies', 'accepted', 2),
    ]);

    expect(found).toEqual([]);
  });

  it('ignores rejections older than 14 days', () => {
    const found = detect([
      stored('notice', 'chat.replies', 'rejected', 15),
      stored('notice', 'chat.replies', 'rejected', 20),
    ]);

    expect(found).toEqual([]);
  });
});

describe('chat.appointment proposals', () => {
  it('mutes a room rejected three times in 30 days', () => {
    const found = detect([
      stored('chat.appointment', '민수', 'rejected', 1),
      stored('chat.appointment', '민수', 'rejected', 10),
      stored('chat.appointment', '민수', 'rejected', 20),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]?.change).toMatchObject({ domain: 'chat.appointment', subject: '민수', action: 'mute' });
    expect(found[0]?.reason).toEqual({ kind: 'room', rejections: 3 });
  });

  it('needs three rejections and no acceptance', () => {
    expect(
      detect([
        stored('chat.appointment', '민수', 'rejected', 1),
        stored('chat.appointment', '민수', 'rejected', 10),
      ]),
    ).toEqual([]);
    expect(
      detect([
        stored('chat.appointment', '민수', 'rejected', 1),
        stored('chat.appointment', '민수', 'rejected', 10),
        stored('chat.appointment', '민수', 'rejected', 20),
        stored('chat.appointment', '민수', 'accepted', 3),
      ]),
    ).toEqual([]);
  });

  it('ignores rejections older than 30 days', () => {
    const found = detect([
      stored('chat.appointment', '민수', 'rejected', 31),
      stored('chat.appointment', '민수', 'rejected', 32),
      stored('chat.appointment', '민수', 'rejected', 33),
    ]);

    expect(found).toEqual([]);
  });
});

describe('spend.category proposals', () => {
  it('learns a word shared by two merchants corrected to the same category', () => {
    const found = detect([
      stored('spend.category', '별빛커피', 'corrected', 2, { correction: 'cafe', label: '별빛 커피' }),
      stored('spend.category', '달빛커피', 'corrected', 3, { correction: 'cafe', label: '달빛 커피' }),
    ]);

    expect(found).toHaveLength(1);
    expect(found[0]?.change).toMatchObject({
      domain: 'spend.category',
      subject: '커피',
      action: 'set',
      value: 'cafe',
    });
    expect(found[0]?.reason).toEqual({
      kind: 'keyword',
      token: '커피',
      category: 'cafe',
      subjects: ['달빛커피', '별빛커피'],
      count: 2,
    });
  });

  it('needs the word on two distinct merchants', () => {
    const found = detect([
      stored('spend.category', '별빛커피', 'corrected', 2, { correction: 'cafe', label: '별빛 커피' }),
      stored('spend.category', '별빛커피', 'corrected', 3, { correction: 'cafe', label: '별빛 커피' }),
    ]);

    expect(found).toEqual([]);
  });

  it('skips a word corrected to different categories', () => {
    const found = detect([
      stored('spend.category', '별빛커피', 'corrected', 2, { correction: 'cafe', label: '별빛 커피' }),
      stored('spend.category', '달빛커피', 'corrected', 3, { correction: 'food', label: '달빛 커피' }),
    ]);

    expect(found).toEqual([]);
  });

  it('learns nothing from stopword-only labels', () => {
    const found = detect([
      stored('spend.category', 'merchant-a', 'corrected', 2, { correction: 'cafe', label: 'Store' }),
      stored('spend.category', 'merchant-b', 'corrected', 3, { correction: 'cafe', label: 'Shop' }),
    ]);

    expect(found).toEqual([]);
  });

  it('ignores corrections older than 30 days and non-category corrections', () => {
    expect(
      detect([
        stored('spend.category', '별빛커피', 'corrected', 31, { correction: 'cafe', label: '별빛 커피' }),
        stored('spend.category', '달빛커피', 'corrected', 32, { correction: 'cafe', label: '달빛 커피' }),
      ]),
    ).toEqual([]);

    expect(
      detect([
        stored('spend.category', '별빛커피', 'corrected', 1, { correction: 'nope', label: '별빛 커피' }),
        stored('spend.category', '달빛커피', 'corrected', 2, { correction: 'nope', label: '달빛 커피' }),
      ]),
    ).toEqual([]);
  });
});

describe('skipping and limiting', () => {
  const noticePairs = (subject: string) => [
    stored('notice', subject, 'rejected', 1),
    stored('notice', subject, 'rejected', 2),
  ];

  it('skips a change that was already applied or declined', () => {
    const feedback = noticePairs('chat.replies');

    expect(detect(feedback, [{ domain: 'notice', subject: 'chat.replies', action: 'mute' }])).toEqual([]);
  });

  it('does not confuse a different value with the same subject', () => {
    const feedback = [
      stored('spend.category', '별빛커피', 'corrected', 2, { correction: 'cafe', label: '별빛 커피' }),
      stored('spend.category', '달빛커피', 'corrected', 3, { correction: 'cafe', label: '달빛 커피' }),
    ];

    const found = detect(feedback, [{ domain: 'spend.category', subject: '커피', action: 'set', value: 'food' }]);

    expect(found).toHaveLength(1);
    expect(found[0]?.change).toMatchObject({ subject: '커피', value: 'cafe' });
  });

  it('caps the list at three proposals', () => {
    const found = detect([
      ...noticePairs('notice.a'),
      ...noticePairs('notice.b'),
      ...noticePairs('notice.c'),
      ...noticePairs('notice.d'),
    ]);

    expect(found).toHaveLength(3);
    expect(found.map((item) => item.change.subject)).toEqual(['notice.a', 'notice.b', 'notice.c']);
  });

  it('is deterministic', () => {
    const feedback = noticePairs('chat.replies');

    expect(detect(feedback)).toEqual(detect(feedback));
  });
});
