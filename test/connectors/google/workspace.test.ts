import { describe, expect, it } from 'vitest';
import { GoogleContacts } from '../../../src/connectors/google/contacts.js';
import { documentText, GoogleDocs } from '../../../src/connectors/google/docs.js';
import { accessHelp, GoogleAccessError, withAccessHelp } from '../../../src/connectors/google/scope-help.js';
import { GoogleSheets, quoteTab } from '../../../src/connectors/google/sheets.js';
import { GoogleTasks, toTodo } from '../../../src/connectors/google/tasks.js';
import {
  googleContactsConnector,
  googleDocsConnector,
  googleSheetsConnector,
  googleTasksConnector,
} from '../../../src/connectors/google/workspace-plugin.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { createTestContext } from '../../support/context.js';
import { fakeFetch, json, requestWithToken } from './helpers.js';

const DOC_ID = 'doc1234567890';
const SHEET_ID = 'sheet1234567890';

const DOC = {
  title: '주간 회의록',
  body: {
    content: [
      { sectionBreak: {} },
      { paragraph: { elements: [{ textRun: { content: '안건\n' } }] } },
      {
        table: {
          tableRows: [
            { tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: '이름\n' } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: '할 일\n' } }] } }] }] },
            { tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: '민수\n' } }] } }] }, { content: [{ paragraph: { elements: [{ textRun: { content: '견적서\n' } }] } }] }] },
          ],
        },
      },
      { paragraph: { elements: [{ textRun: { content: '담당 ' } }, { person: { personProperties: { name: '김민수' } } }, { textRun: { content: '\n' } }] } },
    ],
  },
};

describe('GoogleDocs', () => {
  it('turns paragraphs, tables and people chips into plain text', () => {
    expect(documentText(DOC)).toBe('안건\n이름 | 할 일\n민수 | 견적서\n담당 김민수\n');
  });

  it('reads a doc and cuts it at the limit', async () => {
    const fake = fakeFetch(() => json(DOC));
    const docs = new GoogleDocs(requestWithToken(fake));

    const read = await docs.read(DOC_ID, 5);

    expect(fake.calls[0]?.url.pathname).toBe(`/v1/documents/${DOC_ID}`);
    expect(read).toEqual({ id: DOC_ID, title: '주간 회의록', text: '안건\n이름', truncated: true, url: `https://docs.google.com/document/d/${DOC_ID}/edit` });
  });

  it('appends at the end of the body and creates a doc before filling it', async () => {
    const fake = fakeFetch((call) => (call.url.pathname === '/v1/documents' ? json({ documentId: 'new-doc-1234' }) : json({})));
    const docs = new GoogleDocs(requestWithToken(fake));

    await docs.append(DOC_ID, '\n추가');
    const created = await docs.create('새 문서', '본문');

    expect(fake.calls[0]?.url.pathname).toBe(`/v1/documents/${DOC_ID}:batchUpdate`);
    expect(JSON.parse(fake.calls[0]?.body ?? '{}')).toEqual({ requests: [{ insertText: { endOfSegmentLocation: {}, text: '\n추가' } }] });
    expect(JSON.parse(fake.calls[1]?.body ?? '{}')).toEqual({ title: '새 문서' });
    expect(fake.calls[2]?.url.pathname).toBe('/v1/documents/new-doc-1234:batchUpdate');
    expect(created).toEqual({ id: 'new-doc-1234', url: 'https://docs.google.com/document/d/new-doc-1234/edit' });
  });
});

describe('GoogleSheets', () => {
  it('reads the first tab with row and column caps', async () => {
    const fake = fakeFetch((call) =>
      call.url.pathname.includes('/values/')
        ? json({ range: "'매출 표'!A1:Z1000", values: [['월', '매출', '비고'], ['1월', 100, true], ['2월', '200']] })
        : json({ properties: { title: '매출' }, sheets: [{ properties: { title: '매출 표', gridProperties: { rowCount: 1000, columnCount: 26 } } }] }),
    );
    const sheets = new GoogleSheets(requestWithToken(fake));

    const values = await sheets.read(SHEET_ID, undefined, { rows: 2, columns: 2 });

    expect(decodeURIComponent(fake.calls[1]?.url.pathname ?? '')).toBe(`/v4/spreadsheets/${SHEET_ID}/values/'매출 표'`);
    expect(values).toEqual({ range: "'매출 표'!A1:Z1000", rows: [['월', '매출'], ['1월', '100']], truncated: true });
  });

  it('appends and updates with RAW input so formulas stay text', async () => {
    const fake = fakeFetch((call) =>
      call.method === 'POST' ? json({ updates: { updatedRange: '시트1!A5:B5', updatedRows: 1 } }) : json({ updatedRange: '시트1!B2', updatedCells: 1 }),
    );
    const sheets = new GoogleSheets(requestWithToken(fake));

    await expect(sheets.append(SHEET_ID, '시트1', [['=IMPORTXML("x")', '2']])).resolves.toEqual({ updatedRange: '시트1!A5:B5', rows: 1 });
    await expect(sheets.update(SHEET_ID, '시트1!B2', [['3']])).resolves.toEqual({ updatedRange: '시트1!B2', cells: 1 });

    expect(fake.calls[0]?.url.searchParams.get('valueInputOption')).toBe('RAW');
    expect(fake.calls[0]?.url.pathname.endsWith(':append')).toBe(true);
    expect(fake.calls[1]?.method).toBe('PUT');
    expect(fake.calls[1]?.url.searchParams.get('valueInputOption')).toBe('RAW');
  });

  it('quotes tab names that need it', () => {
    expect(quoteTab('시트1')).toBe('시트1');
    expect(quoteTab("Q1 'final'")).toBe("'Q1 ''final'''");
  });
});

describe('GoogleTasks', () => {
  it('maps tasks to to-dos with date-only due and completion time', () => {
    expect(toTodo({ id: 't1', title: ' 견적서 ', status: 'needsAction', due: '2026-11-20T00:00:00.000Z', updated: '2026-11-17T00:00:00.000Z' })).toEqual({
      id: 't1',
      text: '견적서',
      done: false,
      due: '2026-11-20',
      createdAt: '2026-11-17T00:00:00.000Z',
    });
    expect(toTodo({ id: 't2', title: '', status: 'needsAction' })).toBeUndefined();
    expect(toTodo({ id: 't3', title: 'x', deleted: true })).toBeUndefined();
  });

  it('lists open items and items done since a date with separate queries', async () => {
    const fake = fakeFetch((call) =>
      call.url.searchParams.get('showCompleted') === 'false'
        ? json({ items: [{ id: 'open', title: '열린 일', status: 'needsAction' }] })
        : json({ items: [{ id: 'done', title: '끝난 일', status: 'completed', completed: '2026-11-16T10:00:00.000Z' }, { id: 'open', title: '열린 일', status: 'needsAction' }] }),
    );
    const tasks = new GoogleTasks(requestWithToken(fake), () => new Date('2026-11-17T00:00:00Z'));

    const items = await tasks.list({ completedSince: new Date('2026-11-01T00:00:00Z') });

    expect(items.map((item) => item.id)).toEqual(['open', 'done']);
    expect(fake.calls[1]?.url.searchParams.get('completedMin')).toBe('2026-11-01T00:00:00.000Z');
    expect(fake.calls[0]?.url.pathname).toBe('/tasks/v1/lists/@default/tasks');
  });

  it('adds with a date-only due, completes with PATCH and deletes', async () => {
    const fake = fakeFetch((call) => {
      if (call.method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(call.body ?? '{}') as Record<string, unknown>;
      return json({ id: 't9', title: '보고서', status: body.status ?? 'needsAction', completed: body.completed, due: body.due });
    });
    const tasks = new GoogleTasks(requestWithToken(fake), () => new Date('2026-11-17T00:00:00Z'));

    const added = await tasks.add({ text: '보고서', due: '2026-11-20T15:00:00+09:00' });
    const done = await tasks.complete('t9');
    await tasks.remove('t9');

    expect(JSON.parse(fake.calls[0]?.body ?? '{}')).toEqual({ title: '보고서', due: '2026-11-20T00:00:00.000Z' });
    expect(added.due).toBe('2026-11-20');
    expect(fake.calls[1]?.method).toBe('PATCH');
    expect(done).toMatchObject({ done: true, completedAt: '2026-11-17T00:00:00.000Z' });
    expect(fake.calls[2]).toMatchObject({ method: 'DELETE' });
    expect(fake.calls[2]?.url.pathname).toBe('/tasks/v1/lists/@default/tasks/t9');
  });
});

describe('GoogleContacts', () => {
  it('warms the search cache once, then maps people', async () => {
    const fake = fakeFetch((call) =>
      call.url.searchParams.get('query') === ''
        ? json({})
        : json({
            results: [
              { person: { names: [{ displayName: '김민수' }], emailAddresses: [{ value: 'ms@acme.kr' }, { value: 'ms@acme.kr' }], phoneNumbers: [{ value: '010-1234-5678' }], organizations: [{ name: '에이크미', title: '대표' }] } },
              { person: {} },
            ],
          }),
    );
    const contacts = new GoogleContacts(requestWithToken(fake));

    const first = await contacts.search('김', 5);
    await contacts.search('박', 5);

    expect(first).toEqual([{ name: '김민수', emails: ['ms@acme.kr'], phones: ['010-1234-5678'], organization: '에이크미', title: '대표' }]);
    expect(fake.calls.map((call) => call.url.searchParams.get('query'))).toEqual(['', '김', '박']);
    expect(fake.calls[1]?.url.searchParams.get('readMask')).toBe('names,emailAddresses,phoneNumbers,organizations');
  });
});

describe('access help', () => {
  it('explains a missing scope, an API that is off and a missing item in Korean', () => {
    const scope = accessHelp('docs', 'Google API request failed (HTTP 403): Request had insufficient authentication scopes.');
    expect(scope?.reason).toBe('scope');
    expect(scope?.message).toContain('ax-kit connect google');
    const api = accessHelp('sheets', 'Google API request failed (HTTP 403): Google Sheets API has not been used in project 1 before or it is disabled.');
    expect(api?.message).toContain('Google Sheets API');
    expect(api?.message).toContain('console.cloud.google.com/apis/library');
    expect(accessHelp('tasks', 'Google API request failed (HTTP 404)', { notFound: '없어요' })?.message).toBe('없어요');
    expect(accessHelp('docs', 'Google API request failed (HTTP 403): The caller does not have permission', { denied: '못 고쳐요' })?.reason).toBe('denied');
    expect(accessHelp('docs', 'Google API request failed (HTTP 500)')).toBeUndefined();
  });

  it('wraps a request function', async () => {
    const fake = fakeFetch(() => json({ error: { message: 'Request had insufficient authentication scopes.' } }, 403));
    const request = withAccessHelp(requestWithToken(fake), 'contacts');

    await expect(request('https://people.googleapis.com/v1/x')).rejects.toBeInstanceOf(GoogleAccessError);
    await expect(request('https://people.googleapis.com/v1/x')).rejects.toThrow(/Google 주소록\(Contacts\) 권한이 아직 없어요/);
  });
});

describe('workspace connector plugins', () => {
  async function connected(config: Record<string, unknown> = {}) {
    const context = createTestContext({ config });
    await context.secrets.set('google.oauth-client', JSON.stringify({ clientId: 'client-id', clientSecret: 'secret' }));
    await context.secrets.set('google.refresh-token', 'refresh-1');
    return context;
  }
  const fetchOk = fakeFetch((call) =>
    call.url.hostname === 'oauth2.googleapis.com' ? json({ access_token: 'access-1', expires_in: 3600 }) : json({ error: { message: 'Request had insufficient authentication scopes.' } }, 403),
  );

  it('provides Docs, Tasks and Contacts and turns scope errors into Korean steps', async () => {
    const context = await connected();
    for (const plugin of [googleDocsConnector({ fetch: fetchOk.fetch }), googleTasksConnector({ fetch: fetchOk.fetch }), googleContactsConnector({ fetch: fetchOk.fetch })]) {
      expect(plugin.manifest.secrets).toEqual(['google.oauth-client', 'google.refresh-token']);
      await plugin.setup(context.ctx);
    }

    await expect(context.ctx.use(Contracts.docsRead).read(DOC_ID, 100)).rejects.toThrow(/Google 문서\(Docs\) 권한이 아직 없어요/);
    await expect(context.ctx.use(Contracts.todoBackend).list({})).rejects.toThrow(/Google Tasks\(할 일\) 권한/);
    expect(context.ctx.tryUse(Contracts.docsWrite)).toBeDefined();
    expect(context.ctx.tryUse(Contracts.contactsRead)).toBeDefined();
  });

  it('offers Sheets edits only when the config says write', async () => {
    const readOnly = await connected();
    await googleSheetsConnector({ fetch: fetchOk.fetch }).setup(readOnly.ctx);
    expect(readOnly.ctx.tryUse(Contracts.sheetsRead)).toBeDefined();
    expect(readOnly.ctx.tryUse(Contracts.sheetsWrite)).toBeUndefined();

    const writable = await connected({ write: true });
    await googleSheetsConnector({ fetch: fetchOk.fetch }).setup(writable.ctx);
    expect(writable.ctx.tryUse(Contracts.sheetsWrite)).toBeDefined();
  });
});
