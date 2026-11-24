import { describe, expect, it } from 'vitest';
import type { MailMessage, MailPage, MailQuery, MailReader, MailSummary } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import type { LlmGateway, LlmResponse } from '../../../src/core/llm/types.js';
import { readTriageConfig } from '../../../src/skills/mail/triage-config.js';
import { triageOnce } from '../../../src/skills/mail/triage-job.js';
import { createTestContext } from '../../support/context.js';

const NOW = new Date('2026-11-19T09:00:00+09:00');

function mail(id: string, minute: number): MailMessage {
  return {
    id,
    threadId: `t-${id}`,
    from: 'Mina Kim <mina@example.com>',
    to: ['owner@example.com'],
    cc: [],
    subject: `메일 ${id}`,
    snippet: '',
    receivedAt: new Date(NOW.getTime() + minute * 60_000),
    unread: true,
    important: false,
    body: '확인 부탁드려요.',
  };
}

/** Pages newest first like Gmail; `listed` decides which mail a search still finds. */
class PagedMail implements MailReader {
  inbox: MailMessage[] = [];
  listed: (message: MailMessage) => boolean = () => true;
  readonly tokens: (string | undefined)[] = [];
  constructor(private readonly pageSize: number) {}
  async search(query: MailQuery): Promise<MailSummary[]> {
    return (await this.searchPage(query)).messages;
  }
  async searchPage(_query: MailQuery, pageToken?: string): Promise<MailPage> {
    this.tokens.push(pageToken);
    const all = this.inbox.filter((message) => this.listed(message)).reverse();
    const start = pageToken === undefined ? 0 : Number(pageToken);
    const end = start + this.pageSize;
    return { messages: all.slice(start, end), ...(end < all.length ? { nextPageToken: String(end) } : {}) };
  }
  async read(id: string): Promise<MailMessage> {
    const found = this.inbox.find((message) => message.id === id);
    if (found === undefined) throw new Error(`no mail ${id}`);
    return found;
  }
}

class SwitchLlm implements LlmGateway {
  up = true;
  calls = 0;
  async complete(): Promise<LlmResponse> {
    this.calls += 1;
    if (!this.up) throw new Error('provider down');
    const text = JSON.stringify({ importance: 'normal', summary: '확인 요청이에요.', actions: [] });
    return { text, providerId: 'fake', model: 'fake', usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
  }
}

async function setup(pageSize = 100) {
  const reader = new PagedMail(pageSize);
  const llm = new SwitchLlm();
  const context = createTestContext({ now: NOW, llm, capabilities: { [Contracts.mailRead.id]: reader } });
  const config = readTriageConfig(context.ctx);
  const run = () => triageOnce(context.ctx, config, context.clock.now());
  expect((await run()).status).toBe('seeded');
  const cursor = async () => (await context.kv.get<{ at: string; backlog: { id: string; tries: number }[] }>('triage:cursor'))!;
  return { reader, llm, context, run, cursor };
}

describe('mail triage backlog', () => {
  it('keeps mail over the per-run cap and handles it next run even when the search no longer finds it', async () => {
    const s = await setup();
    for (let index = 0; index < 25; index += 1) s.reader.inbox.push(mail(`m${index}`, index));
    expect((await s.run()).triaged).toBe(20);
    expect((await s.cursor()).backlog.map((entry) => entry.id)).toEqual(['m20', 'm21', 'm22', 'm23', 'm24']);
    s.reader.listed = () => false;
    expect((await s.run()).triaged).toBe(5);
    expect((await s.cursor()).backlog).toEqual([]);
    expect((await s.run()).triaged).toBe(0);
  });

  it('retries mail whose classification failed, and gives up after five tries', async () => {
    const s = await setup();
    s.reader.inbox.push(mail('a', 1));
    s.llm.up = false;
    expect((await s.run()).triaged).toBe(0);
    expect((await s.cursor()).backlog).toEqual([{ id: 'a', tries: 1 }]);
    s.reader.listed = () => false;
    s.llm.up = true;
    expect((await s.run()).triaged).toBe(1);

    s.reader.inbox.push(mail('b', 2));
    s.reader.listed = (message) => message.id === 'b';
    s.llm.up = false;
    for (let index = 0; index < 5; index += 1) await s.run();
    expect((await s.cursor()).backlog).toEqual([]);
    s.llm.up = true;
    expect((await s.run()).triaged).toBe(0);
  });

  it('pages through every match, and keeps the cursor when the page cap cut the search short', async () => {
    const s = await setup(2);
    for (let index = 0; index < 5; index += 1) s.reader.inbox.push(mail(`p${index}`, index));
    expect((await s.run()).triaged).toBe(5);
    expect(s.reader.tokens.slice(-3)).toEqual([undefined, '2', '4']);
    expect((await s.cursor()).at).toBe(NOW.toISOString());

    const flood = await setup(1);
    const firstAt = (await flood.cursor()).at;
    await flood.context.clock.advance(60_000);
    for (let index = 0; index < 12; index += 1) flood.reader.inbox.push(mail(`f${index}`, index));
    await flood.run();
    expect((await flood.cursor()).at).toBe(firstAt);
  });
});
