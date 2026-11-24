import type { DocReplaceResult, DocTarget, DocText, DocsEditor, DocsReader, DocsWriter } from '../../core/contracts/workspace.js';
import type { GoogleRequestFn } from './http.js';
import { isRecord } from './json.js';

const DOCS = 'https://docs.googleapis.com/v1/documents';
const MAX_TEXT_CHARS = 50_000;
const MAX_DEPTH = 6;

function docUrl(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`;
}

function withSignal(init: RequestInit, signal: AbortSignal | undefined): RequestInit {
  return signal === undefined ? init : { ...init, signal };
}

function paragraphText(paragraph: unknown): string {
  if (!isRecord(paragraph) || !Array.isArray(paragraph.elements)) return '';
  let text = '';
  for (const element of paragraph.elements) {
    if (!isRecord(element)) continue;
    const run = element.textRun;
    if (isRecord(run) && typeof run.content === 'string') text += run.content;
    const person = element.person;
    if (isRecord(person) && isRecord(person.personProperties) && typeof person.personProperties.name === 'string') {
      text += person.personProperties.name;
    }
    const chip = element.richLink;
    if (isRecord(chip) && isRecord(chip.richLinkProperties) && typeof chip.richLinkProperties.title === 'string') {
      text += chip.richLinkProperties.title;
    }
  }
  return text;
}

function contentText(content: unknown, depth: number): string {
  if (!Array.isArray(content) || depth > MAX_DEPTH) return '';
  const parts: string[] = [];
  for (const element of content) {
    if (!isRecord(element)) continue;
    if (element.paragraph !== undefined) parts.push(paragraphText(element.paragraph));
    else if (isRecord(element.table)) parts.push(tableText(element.table, depth));
    else if (isRecord(element.tableOfContents)) parts.push(contentText(element.tableOfContents.content, depth + 1));
  }
  return parts.join('');
}

/** A table becomes one line per row with cells split by " | ", which keeps it readable as text. */
function tableText(table: Record<string, unknown>, depth: number): string {
  if (!Array.isArray(table.tableRows)) return '';
  const lines: string[] = [];
  for (const row of table.tableRows) {
    if (!isRecord(row) || !Array.isArray(row.tableCells)) continue;
    const cells = row.tableCells.map((cell) =>
      isRecord(cell) ? contentText(cell.content, depth + 1).replace(/\s+/g, ' ').trim() : '',
    );
    lines.push(cells.join(' | '));
  }
  return `${lines.join('\n')}\n`;
}

export interface DocTab {
  /** Undefined only for a document returned without tabs (old API shape). */
  id: string | undefined;
  title: string;
  text: string;
}

function walkTabs(tabs: unknown, depth: number, out: DocTab[]): void {
  if (!Array.isArray(tabs) || depth > MAX_DEPTH) return;
  for (const tab of tabs) {
    if (!isRecord(tab)) continue;
    const props = isRecord(tab.tabProperties) ? tab.tabProperties : {};
    const body = isRecord(tab.documentTab) && isRecord(tab.documentTab.body) ? tab.documentTab.body : {};
    out.push({
      id: typeof props.tabId === 'string' ? props.tabId : undefined,
      title: typeof props.title === 'string' ? props.title : '',
      text: contentText(body.content, 0),
    });
    walkTabs(tab.childTabs, depth + 1, out);
  }
}

/** Every tab in reading order (a tab, then its child tabs), or the body alone when the reply has no tabs. */
export function documentTabs(doc: unknown): DocTab[] {
  if (!isRecord(doc)) return [];
  const tabs: DocTab[] = [];
  walkTabs(doc.tabs, 0, tabs);
  if (tabs.length > 0) return tabs;
  return isRecord(doc.body) ? [{ id: undefined, title: '', text: contentText(doc.body.content, 0) }] : [];
}

/** Plain text of a document, paragraphs and tables in order. With more than one tab, each starts with "## <title>". */
export function documentText(doc: unknown): string {
  const tabs = documentTabs(doc);
  if (tabs.length <= 1) return tabs[0]?.text ?? '';
  return tabs
    .map((tab, index) => {
      const text = tab.text.endsWith('\n') || tab.text === '' ? tab.text : `${tab.text}\n`;
      return `${index === 0 ? '' : '\n'}## ${tab.title === '' ? `탭 ${index + 1}` : tab.title}\n${text}`;
    })
    .join('');
}

/** The tab with this title (exact, then ignoring case and spaces at the ends), or the first tab without one. */
export function pickTab(tabs: readonly DocTab[], title: string | undefined): DocTab {
  const first = tabs[0];
  if (first === undefined) throw new Error('문서 내용을 읽지 못했어요.');
  if (title === undefined || title.trim() === '') return first;
  const loose = (text: string): string => text.trim().toLowerCase();
  const found = tabs.find((tab) => tab.title === title) ?? tabs.find((tab) => loose(tab.title) === loose(title));
  if (found !== undefined) return found;
  const names = tabs.map((tab) => `"${tab.title}"`).join(', ');
  throw new Error(`이 문서에 "${title}" 탭이 없어요. 있는 탭: ${names}`);
}

function occurrences(text: string, phrase: string): number {
  let count = 0;
  for (let at = text.indexOf(phrase); at !== -1; at = text.indexOf(phrase, at + phrase.length)) count += 1;
  return count;
}

const JSON_POST = { method: 'POST', headers: { 'content-type': 'application/json' } } as const;

/**
 * Google Docs over the Docs API. Reads need `documents.readonly` or `documents`. Writes reach any doc the owner can
 * edit with `documents` ("문서 고치기"), otherwise only docs ax-kit made (`drive.file`).
 */
export class GoogleDocs implements DocsReader, DocsWriter, DocsEditor {
  constructor(private readonly request: GoogleRequestFn) {}

  async read(id: string, maxChars: number, signal?: AbortSignal): Promise<DocText> {
    const doc = await this.fetchDoc(id, signal);
    const title = isRecord(doc) && typeof doc.title === 'string' ? doc.title : '';
    const full = documentText(doc);
    const limit = Math.max(0, Math.min(maxChars, MAX_TEXT_CHARS));
    return { id, title, text: full.slice(0, limit), truncated: full.length > limit, url: docUrl(id) };
  }

  async append(id: string, text: string, target: DocTarget = {}, signal?: AbortSignal): Promise<{ id: string; url: string }> {
    // Without a tab title Google appends to the first tab, so the document is fetched only to find a named tab.
    const tabId = target.tab === undefined ? undefined : pickTab(documentTabs(await this.fetchDoc(id, signal)), target.tab).id;
    await this.insertAtEnd(id, text, tabId, signal);
    return { id, url: docUrl(id) };
  }

  async replaceText(id: string, find: string, replace: string, target: DocTarget = {}, signal?: AbortSignal): Promise<DocReplaceResult> {
    const tab = pickTab(documentTabs(await this.fetchDoc(id, signal)), target.tab);
    const where = tab.title === '' ? '문서' : `"${tab.title}" 탭`;
    const count = occurrences(tab.text, find);
    if (count === 0) throw new Error(`${where}에서 "${find}" 문구를 찾지 못했어요. 문서에 있는 그대로 적어 주세요.`);
    if (count > 1) throw new Error(`${where}에 "${find}" 문구가 ${count}군데 있어요. 한 곳만 바꾸도록 앞뒤 글을 더 붙여 주세요.`);
    const body = {
      requests: [
        {
          replaceAllText: {
            containsText: { text: find, matchCase: true },
            replaceText: replace,
            ...(tab.id !== undefined ? { tabsCriteria: { tabIds: [tab.id] } } : {}),
          },
        },
      ],
    };
    const reply = await this.request<{ replies?: unknown }>(
      `${DOCS}/${encodeURIComponent(id)}:batchUpdate`,
      withSignal({ ...JSON_POST, body: JSON.stringify(body) }, signal),
    );
    const first = Array.isArray(reply.replies) ? reply.replies[0] : undefined;
    const changed = isRecord(first) && isRecord(first.replaceAllText) ? first.replaceAllText.occurrencesChanged : undefined;
    return { id, url: docUrl(id), replaced: typeof changed === 'number' ? changed : 0 };
  }

  async create(title: string, text: string, signal?: AbortSignal): Promise<{ id: string; url: string }> {
    const created = await this.request<{ documentId?: unknown }>(
      DOCS,
      withSignal({ ...JSON_POST, body: JSON.stringify({ title: title.slice(0, 200) }) }, signal),
    );
    if (typeof created.documentId !== 'string' || created.documentId === '') {
      throw new Error('Google 문서를 만들었지만 문서 id를 받지 못했어요.');
    }
    if (text !== '') await this.insertAtEnd(created.documentId, text, undefined, signal);
    return { id: created.documentId, url: docUrl(created.documentId) };
  }

  private async fetchDoc(id: string, signal: AbortSignal | undefined): Promise<unknown> {
    return await this.request<unknown>(`${DOCS}/${encodeURIComponent(id)}?includeTabsContent=true`, withSignal({}, signal));
  }

  private async insertAtEnd(id: string, text: string, tabId: string | undefined, signal: AbortSignal | undefined): Promise<void> {
    const body = { requests: [{ insertText: { endOfSegmentLocation: tabId === undefined ? {} : { tabId }, text } }] };
    await this.request<unknown>(
      `${DOCS}/${encodeURIComponent(id)}:batchUpdate`,
      withSignal({ ...JSON_POST, body: JSON.stringify(body) }, signal),
    );
  }
}
