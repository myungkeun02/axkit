import { describe, expect, it } from 'vitest';
import type { Contact, ContactsReader, DocsReader, DocsWriter, SheetsReader, SheetsWriter } from '../../../src/core/contracts/index.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { workspaceSkill } from '../../../src/skills/workspace/plugin.js';
import { contactQuery, googleFileId } from '../../../src/skills/workspace/refs.js';
import { createTestContext, FakeConfirmer } from '../../support/context.js';

const DOC_ID = '1AbCdEfGhIjKlMnOp';
const BODY = 'A'.repeat(4000) + 'B'.repeat(10);

function fakes() {
  const calls: string[] = [];
  const docsRead: DocsReader = {
    async read(id, maxChars) {
      return { id, title: '사업계획서', text: BODY.slice(0, maxChars), truncated: maxChars < BODY.length, url: `https://docs.google.com/document/d/${id}/edit` };
    },
  };
  const docsWrite: DocsWriter = {
    async append(id, text) {
      calls.push(`append:${id}:${text}`);
      return { id, url: 'u' };
    },
    async create(title, text) {
      calls.push(`create:${title}:${text}`);
      return { id: 'newdoc12345', url: 'u2' };
    },
  };
  const sheetsRead: SheetsReader = {
    async info(id) {
      return { id, title: '매출', tabs: [{ title: '2026 매출', rows: 100, columns: 10 }], url: 'u' };
    },
    async read(_id, range) {
      calls.push(`read:${range ?? ''}`);
      return { range: `${range ?? ''}!A1:B2`, rows: [['월', '매출']], truncated: false };
    },
  };
  const sheetsWrite: SheetsWriter = {
    async append(_id, range, rows) {
      calls.push(`appendRows:${range}:${rows.length}`);
      return { updatedRange: range, rows: rows.length };
    },
    async update(_id, range, rows) {
      calls.push(`update:${range}`);
      return { updatedRange: range, cells: rows.flat().length };
    },
  };
  const people: Contact[] = [
    { name: '김민수', emails: ['ms@a.kr'], phones: [], organization: '에이', title: '과장' },
    { name: '김영희', emails: ['yh@b.kr'], phones: [], organization: '비', title: '대표' },
  ];
  const searched: string[] = [];
  const contacts: ContactsReader = {
    async search(query) {
      searched.push(query);
      return people;
    },
  };
  return { calls, searched, caps: { docsRead, docsWrite, sheetsRead, sheetsWrite, contacts } };
}

async function setup(confirmer = new FakeConfirmer()) {
  const f = fakes();
  const context = createTestContext({
    confirmer,
    policy: { confirmWrites: true, expiresMinutes: 30 },
    capabilities: {
      [Contracts.docsRead.id]: f.caps.docsRead,
      [Contracts.docsWrite.id]: f.caps.docsWrite,
      [Contracts.sheetsRead.id]: f.caps.sheetsRead,
      [Contracts.sheetsWrite.id]: f.caps.sheetsWrite,
      [Contracts.contactsRead.id]: f.caps.contacts,
    },
  });
  await workspaceSkill({ docs: true, sheets: true, sheetsWrite: true, contacts: true }).setup(context.ctx);
  const run = (name: string, input: unknown) => context.ctx.tools.execute(name, input, { grounding: [] });
  return { ...f, context, confirmer, run };
}

function output<T>(outcome: { status: string; output?: unknown }): T {
  if (outcome.status !== 'done') throw new Error(`expected done, got ${JSON.stringify(outcome)}`);
  return outcome.output as T;
}

describe('references', () => {
  it('finds ids in Docs, Sheets and Drive addresses', () => {
    expect(googleFileId(DOC_ID)).toBe(DOC_ID);
    expect(googleFileId(`https://docs.google.com/document/d/${DOC_ID}/edit?tab=t.0`)).toBe(DOC_ID);
    expect(googleFileId(`https://docs.google.com/spreadsheets/u/1/d/${DOC_ID}/edit#gid=0`)).toBe(DOC_ID);
    expect(googleFileId(`https://drive.google.com/open?id=${DOC_ID}`)).toBe(DOC_ID);
    expect(googleFileId(`https://evil.example.com/document/d/${DOC_ID}`)).toBeUndefined();
    expect(googleFileId('회의록')).toBeUndefined();
  });

  it('takes honorifics and titles off a name', () => {
    expect(contactQuery('김 대표님')).toEqual({ term: '김', titles: ['대표'] });
    expect(contactQuery('박민수부회장님')).toEqual({ term: '박민수', titles: ['부회장'] });
    expect(contactQuery('민수씨')).toEqual({ term: '민수', titles: [] });
    expect(contactQuery('ms@a.kr')).toEqual({ term: 'ms@a.kr', titles: [] });
    expect(contactQuery('010-1234-5678')).toEqual({ term: '010-1234-5678', titles: [] });
    expect(contactQuery('대표님')).toEqual({ term: '대표', titles: ['대표'] });
  });
});

describe('workspace tools', () => {
  it('registers only the tools for connected parts', async () => {
    const context = createTestContext({ capabilities: { [Contracts.sheetsRead.id]: fakes().caps.sheetsRead } });
    const plugin = workspaceSkill({ sheets: true });
    expect(plugin.manifest.needs).toEqual([Contracts.sheetsRead]);
    await plugin.setup(context.ctx);
    expect(context.registry.list().map((tool) => tool.name)).toEqual(['sheets.read']);
  });

  it('reads a doc in pages and marks it as data', async () => {
    const { run } = await setup();

    const first = output<{ text: string; nextOffset?: number; note: string; title: string }>(
      await run('docs.read', { doc: `https://docs.google.com/document/d/${DOC_ID}/edit` }),
    );
    expect(first.text).toHaveLength(3000);
    expect(first.nextOffset).toBe(3000);
    expect(first.note).toContain('데이터');

    const last = output<{ text: string; nextOffset?: number }>(await run('docs.read', { doc: DOC_ID, offset: 3500, max: 3500 }));
    expect(last.text).toBe('A'.repeat(500) + 'B'.repeat(10));
    expect(last.nextOffset).toBeUndefined();
  });

  it('refuses a reference that is not a Google file', async () => {
    const { run } = await setup();
    expect(await run('docs.read', { doc: '회의록' })).toMatchObject({ status: 'rejected' });
  });

  it('asks before appending, naming the doc read earlier and the text', async () => {
    const { run, confirmer, calls } = await setup();
    await run('docs.read', { doc: DOC_ID });

    output(await run('docs.append', { doc: DOC_ID, text: '결정: 출시 연기' }));

    const card = confirmer.requests[0]?.summary ?? '';
    expect(card).toContain('Google 문서에 글 덧붙이기: 사업계획서');
    expect(card).toContain('결정: 출시 연기');
    expect(calls).toContain(`append:${DOC_ID}:\n결정: 출시 연기`);
  });

  it('does nothing when the owner declines a new doc', async () => {
    const { run, calls } = await setup(new FakeConfirmer('denied'));
    expect(await run('docs.create', { title: '메모', text: '본문' })).toMatchObject({ status: 'denied' });
    expect(calls).toEqual([]);
  });

  it('reads the first tab, quoting its name, and lists the tabs', async () => {
    const { run, calls } = await setup();
    const read = output<{ title: string; tabs: unknown[]; rows: string[][] }>(await run('sheets.read', { sheet: DOC_ID }));
    expect(calls).toEqual(["read:'2026 매출'"]);
    expect(read.title).toBe('매출');
    expect(read.tabs).toHaveLength(1);
  });

  it('shows the sheet, range and row count on the append card', async () => {
    const { run, confirmer, calls } = await setup();
    await run('sheets.read', { sheet: DOC_ID });

    output(await run('sheets.append_rows', { sheet: DOC_ID, range: '2026 매출', rows: [['12월', '300'], ['합계', '=SUM(B:B)']] }));

    const card = confirmer.requests[0]?.summary ?? '';
    expect(card).toContain('Google 시트에 행 추가: 매출');
    expect(card).toContain('범위: 2026 매출 · 2행');
    expect(card).toContain('1) 12월 | 300');
    expect(calls).toContain('appendRows:2026 매출:2');
  });

  it('caps a range update at one hundred cells', async () => {
    const { run } = await setup();
    const rows = Array.from({ length: 21 }, () => ['x']);
    expect(await run('sheets.update_range', { sheet: DOC_ID, range: 'A1:A21', rows })).toMatchObject({ status: 'invalid_input' });
    const many = Array.from({ length: 20 }, () => Array.from({ length: 6 }, () => 'x'));
    expect(await run('sheets.update_range', { sheet: DOC_ID, range: 'A1:F20', rows: many })).toMatchObject({ status: 'rejected' });
  });

  it('finds 김 대표님 with the 대표 first and without asking', async () => {
    const { run, searched, confirmer } = await setup();

    const found = output<{ contacts: Contact[]; searched: string }>(await run('contacts.search', { query: '김 대표님' }));

    expect(searched).toEqual(['김']);
    expect(found.contacts.map((contact) => contact.name)).toEqual(['김영희', '김민수']);
    expect(confirmer.requests).toHaveLength(0);
  });
});
