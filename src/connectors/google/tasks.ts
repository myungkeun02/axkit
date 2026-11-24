import type { TodoBackend, TodoItem } from '../../core/contracts/todo.js';
import type { GoogleRequestFn } from './http.js';
import { isRecord } from './json.js';

const LIST = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';
const PAGE_SIZE = 100;
const MAX_PAGES = 5;
const YMD = /^\d{4}-\d{2}-\d{2}/;

/** A Google task as a to-do. Tasks has no creation time, so the last update stands in for it. */
export function toTodo(raw: unknown): TodoItem | undefined {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id === '') return undefined;
  if (raw.deleted === true) return undefined;
  const text = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (text === '') return undefined;
  const done = raw.status === 'completed';
  const due = typeof raw.due === 'string' ? YMD.exec(raw.due)?.[0] : undefined;
  const updated = typeof raw.updated === 'string' ? raw.updated : new Date(0).toISOString();
  return {
    id: raw.id,
    text,
    done,
    createdAt: updated,
    ...(due !== undefined ? { due } : {}),
    ...(done && typeof raw.completed === 'string' ? { completedAt: raw.completed } : {}),
  };
}

function taskUrl(id: string): string {
  return `${LIST}/${encodeURIComponent(id)}`;
}

/** The owner's default Google Tasks list as the to-do skill's backend. */
export class GoogleTasks implements TodoBackend {
  readonly label = 'google-tasks';

  constructor(
    private readonly request: GoogleRequestFn,
    private readonly now: () => Date,
  ) {}

  async list(opts: { completedSince?: Date }): Promise<TodoItem[]> {
    const open = await this.fetch({ showCompleted: 'false' });
    if (opts.completedSince === undefined) return open.filter((item) => !item.done);
    // completedMin narrows the done query only, so open items come from their own query.
    const done = await this.fetch({
      showCompleted: 'true',
      showHidden: 'true',
      completedMin: opts.completedSince.toISOString(),
    });
    const seen = new Set<string>();
    const items: TodoItem[] = [];
    for (const item of [...open.filter((entry) => !entry.done), ...done.filter((entry) => entry.done)]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
    return items;
  }

  async add(draft: { text: string; due?: string }): Promise<TodoItem> {
    const ymd = draft.due === undefined ? undefined : YMD.exec(draft.due)?.[0];
    const body = { title: draft.text, ...(ymd !== undefined ? { due: `${ymd}T00:00:00.000Z` } : {}) };
    const created = await this.request<unknown>(LIST, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const item = toTodo(created);
    if (item === undefined) throw new Error('Google Tasks에 할 일을 넣었지만 결과를 읽지 못했어요.');
    return item;
  }

  async complete(id: string): Promise<TodoItem> {
    const updated = await this.request<unknown>(taskUrl(id), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'completed', completed: this.now().toISOString() }),
    });
    const item = toTodo(updated);
    if (item === undefined) throw new Error('Google Tasks의 할 일을 끝냈지만 결과를 읽지 못했어요.');
    return item;
  }

  async remove(id: string): Promise<void> {
    await this.request<unknown>(taskUrl(id), { method: 'DELETE' });
  }

  private async fetch(params: Record<string, string>): Promise<TodoItem[]> {
    const items: TodoItem[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(LIST);
      url.searchParams.set('maxResults', String(PAGE_SIZE));
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
      const payload = await this.request<{ items?: unknown; nextPageToken?: unknown }>(url.toString());
      for (const raw of Array.isArray(payload.items) ? payload.items : []) {
        const item = toTodo(raw);
        if (item !== undefined) items.push(item);
      }
      pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : undefined;
      if (pageToken === undefined) break;
    }
    return items;
  }
}
