import { describe, expect, it } from 'vitest';
import type { Doc, DocAuthor, DocEntry } from '../../../src/core/contracts/docs.js';
import { renderDoc } from '../../../src/core/docs/render.js';

const OWNER: DocAuthor = { kind: 'user', id: 'owner' };

function entry(at: string, text: string, author: DocAuthor = OWNER): DocEntry {
  return { at, text, author, sources: [] };
}

function doc(overrides: Partial<Doc> = {}): Doc {
  return {
    id: 'company:profile',
    kind: 'company',
    scope: 'company',
    title: '회사 소개',
    body: '한 사람이 만드는 작은 회사예요.',
    entries: [],
    basedOnFacts: [],
    needsReview: false,
    updatedAt: '2026-11-17T09:00:00.000Z',
    ...overrides,
  };
}

describe('renderDoc', () => {
  it('renders title, body and the newest entries with dates and authors', () => {
    const rendered = renderDoc(
      doc({
        needsReview: true,
        reviewReason: '사실 만료',
        entries: [
          entry('2026-11-15T09:00:00.000Z', 'old'),
          entry('2026-11-17T09:00:00.000Z', 'newest'),
          entry('2026-11-16T09:00:00.000Z', 'middle', { kind: 'agent', id: 'skill.memory' }),
        ],
      }),
      { maxEntries: 2, reviewLabel: '확인이 필요해요' },
    );

    expect(rendered).toBe(
      [
        '# 회사 소개',
        '> 확인이 필요해요: 사실 만료',
        '한 사람이 만드는 작은 회사예요.',
        '- 2026-11-17 newest (owner)',
        '- 2026-11-16 middle (skill.memory)',
      ].join('\n'),
    );
  });

  it('omits the reason separator, empty bodies and extra entries when not applicable', () => {
    const rendered = renderDoc(doc({ needsReview: true, body: '  ', entries: [entry('2026-11-16T09:00:00.000Z', 'x')] }), {
      maxEntries: 0,
      reviewLabel: '확인이 필요해요',
    });

    expect(rendered).toBe('# 회사 소개\n> 확인이 필요해요');
  });

  it('keeps the raw value when an entry time cannot be parsed', () => {
    const rendered = renderDoc(doc({ entries: [entry('not-a-date', 'x')] }), { maxEntries: 5, reviewLabel: '확인' });
    expect(rendered).toContain('- not-a-date x (owner)');
  });
});
