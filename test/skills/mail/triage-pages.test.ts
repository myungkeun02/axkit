import { describe, expect, it } from 'vitest';
import type { MailReader, MailSummary } from '../../../src/core/contracts/index.js';
import { searchAll } from '../../../src/skills/mail/triage-cursor.js';

function reader(pages: number, perPage: number): MailReader {
  return {
    search: async () => [],
    searchPage: async (_query: unknown, token: string | undefined) => {
      const page = token === undefined ? 0 : Number(token);
      const messages = Array.from({ length: perPage }, (_, index) => ({ id: `m${page * perPage + index}` }) as MailSummary);
      return { messages, ...(page + 1 < pages ? { nextPageToken: String(page + 1) } : {}) };
    },
  } as unknown as MailReader;
}

describe('searchAll', () => {
  it('walks through pages of mail already handled without using up the cap', async () => {
    // 15 pages: the first 12 are already handled, the last 3 are new
    const result = await searchAll(reader(15, 10), { limit: 10 }, (id) => Number(id.slice(1)) < 120);
    expect(result.complete).toBe(true);
    expect(result.found.some((mail) => mail.id === 'm149')).toBe(true);
  });

  it('stops after ten pages with new mail', async () => {
    const result = await searchAll(reader(30, 10), { limit: 10 });
    expect(result.complete).toBe(false);
    expect(result.found).toHaveLength(100);
  });
});
