import { describe, expect, it } from 'vitest';
import { documentText, GoogleDocs } from '../../../src/connectors/google/docs.js';
import { googleDocsConnector } from '../../../src/connectors/google/workspace-plugin.js';
import { Contracts } from '../../../src/core/contracts/index.js';
import { createTestContext } from '../../support/context.js';
import { fakeFetch, json, requestWithToken } from './helpers.js';

const DOC_ID = 'doc1234567890';

const para = (text: string) => ({ paragraph: { elements: [{ textRun: { content: text } }] } });
const tab = (tabId: string, title: string, texts: string[], childTabs: unknown[] = []) => ({
  tabProperties: { tabId, title },
  documentTab: { body: { content: texts.map(para) } },
  childTabs,
});

const TABBED = {
  title: '사업계획',
  tabs: [
    tab('t.0', '개요', ['목표: 매출 2배\n']),
    tab('t.1', '일정', ['3월 출시\n'], [tab('t.2', '세부 일정', ['3월 2일 베타\n'])]),
  ],
};

describe('Google Docs tabs', () => {
  it('reads every tab, child tabs too, each under its title', async () => {
    const fake = fakeFetch(() => json(TABBED));
    const docs = new GoogleDocs(requestWithToken(fake));

    const read = await docs.read(DOC_ID, 10_000);

    expect(fake.calls[0]?.url.searchParams.get('includeTabsContent')).toBe('true');
    expect(read.text).toBe('## 개요\n목표: 매출 2배\n\n## 일정\n3월 출시\n\n## 세부 일정\n3월 2일 베타\n');
    expect(read.truncated).toBe(false);
  });

  it('keeps a one-tab document as plain text and still cuts at the limit', async () => {
    expect(documentText({ tabs: [tab('t.0', '탭 1', ['안녕\n'])] })).toBe('안녕\n');
    const fake = fakeFetch(() => json(TABBED));
    const read = await new GoogleDocs(requestWithToken(fake)).read(DOC_ID, 8);
    expect(read).toMatchObject({ text: '## 개요\n목표', truncated: true });
  });

  it('appends to the first tab without reading, and to a named tab by its id', async () => {
    const fake = fakeFetch((call) => (call.method === 'GET' ? json(TABBED) : json({})));
    const docs = new GoogleDocs(requestWithToken(fake));

    await docs.append(DOC_ID, '\n메모');
    await docs.append(DOC_ID, '\n3월 9일 정식', { tab: '세부 일정' });

    expect(fake.calls.map((call) => call.method)).toEqual(['POST', 'GET', 'POST']);
    expect(JSON.parse(fake.calls[0]?.body ?? '{}').requests[0].insertText.endOfSegmentLocation).toEqual({});
    expect(JSON.parse(fake.calls[2]?.body ?? '{}').requests[0].insertText).toEqual({ endOfSegmentLocation: { tabId: 't.2' }, text: '\n3월 9일 정식' });
    await expect(docs.append(DOC_ID, 'x', { tab: '예산' })).rejects.toThrow('이 문서에 "예산" 탭이 없어요. 있는 탭: "개요", "일정", "세부 일정"');
  });

  it('replaces a phrase only when it appears once in the tab', async () => {
    const doc = { title: '계약', tabs: [tab('t.0', '본문', ['금액은 100만원\n', '기간은 1년, 1년 뒤 갱신\n'])] };
    const fake = fakeFetch((call) => (call.method === 'GET' ? json(doc) : json({ replies: [{ replaceAllText: { occurrencesChanged: 1 } }] })));
    const docs = new GoogleDocs(requestWithToken(fake));

    const done = await docs.replaceText(DOC_ID, '100만원', '120만원');

    expect(done).toEqual({ id: DOC_ID, url: `https://docs.google.com/document/d/${DOC_ID}/edit`, replaced: 1 });
    expect(JSON.parse(fake.calls[1]?.body ?? '{}')).toEqual({
      requests: [{ replaceAllText: { containsText: { text: '100만원', matchCase: true }, replaceText: '120만원', tabsCriteria: { tabIds: ['t.0'] } } }],
    });
    await expect(docs.replaceText(DOC_ID, '1년', '2년')).rejects.toThrow('"본문" 탭에 "1년" 문구가 2군데 있어요');
    await expect(docs.replaceText(DOC_ID, '200만원', 'x')).rejects.toThrow('"본문" 탭에서 "200만원" 문구를 찾지 못했어요');
    expect(fake.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
});

describe('Google Docs levels', () => {
  async function connected(config: Record<string, unknown>) {
    const context = createTestContext({ config });
    await context.secrets.set('google.oauth-client', JSON.stringify({ clientId: 'client-id', clientSecret: 'secret' }));
    await context.secrets.set('google.refresh-token', 'refresh-1');
    return context;
  }
  const denied = fakeFetch((call) =>
    call.url.hostname === 'oauth2.googleapis.com' ? json({ access_token: 'a', expires_in: 3600 }) : json({ error: { message: 'The caller does not have permission' } }, 403),
  );

  it('offers writing and replacing only at the levels that allow them', async () => {
    const read = await connected({ enabled: true, level: 'read' });
    await googleDocsConnector({ fetch: denied.fetch }).setup(read.ctx);
    expect(read.ctx.tryUse(Contracts.docsRead)).toBeDefined();
    expect(read.ctx.tryUse(Contracts.docsWrite)).toBeUndefined();

    const edit = await connected({ enabled: true, level: 'edit' });
    await googleDocsConnector({ fetch: denied.fetch }).setup(edit.ctx);
    expect(edit.ctx.tryUse(Contracts.docsEdit)).toBeDefined();
    await expect(edit.ctx.use(Contracts.docsWrite).append(DOC_ID, 'x')).rejects.toThrow('편집자로 공유받은 문서인지');
  });

  it('tells how to turn on 문서 고치기 when a doc ax-kit did not make cannot be changed', async () => {
    const saved = await connected({ enabled: true });
    await googleDocsConnector({ fetch: denied.fetch }).setup(saved.ctx);
    expect(saved.ctx.tryUse(Contracts.docsEdit)).toBeUndefined();
    const error = saved.ctx.use(Contracts.docsWrite).append(DOC_ID, 'x');
    await expect(error).rejects.toThrow('ax-kit이 직접 만든 문서에만');
    await expect(saved.ctx.use(Contracts.docsWrite).append(DOC_ID, 'x')).rejects.toThrow('"문서 고치기"를 켜 주세요');
  });
});
