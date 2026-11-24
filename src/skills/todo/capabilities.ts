import type { TodoDraft, TodoReader, TodoWriter } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { StoredTodo, TodoRepo } from './store.js';
import { newTodoId, toTodoItem } from './tools-shared.js';

const MAX_TEXT_LENGTH = 200;
/** Briefings and views may read an outside list's copy up to a minute old. */
const READ_MAX_AGE_MS = 60_000;

function assertDate(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) throw new RangeError(`${field} is not a date: ${value}`);
}

function newItem(draft: TodoDraft, now: Date): StoredTodo {
  const text = draft.text.trim();
  if (text.length < 1 || text.length > MAX_TEXT_LENGTH) {
    throw new RangeError(`to-do text must be 1 to ${MAX_TEXT_LENGTH} characters`);
  }
  if (draft.due !== undefined) assertDate(draft.due, 'due');
  if (draft.remindAt !== undefined) assertDate(draft.remindAt, 'remindAt');
  return {
    id: newTodoId(),
    text,
    done: false,
    createdAt: now.toISOString(),
    ...(draft.due !== undefined ? { due: draft.due } : {}),
    ...(draft.remindAt !== undefined ? { remindAt: draft.remindAt } : {}),
  };
}

/** The to-do skill's public capabilities: read for the briefing, write for voice memos and messages. */
export function provideTodoCapabilities(ctx: PluginContext, store: TodoRepo, now: () => Date): void {
  const reader: TodoReader = {
    async open() {
      await store.sync(READ_MAX_AGE_MS);
      return store
        .all()
        .filter((item) => !item.done)
        .map(toTodoItem);
    },
    async doneSince(since) {
      await store.sync(READ_MAX_AGE_MS);
      return store
        .all()
        .filter(
          (item) => item.done && item.completedAt !== undefined && new Date(item.completedAt).getTime() >= since.getTime(),
        )
        .sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''))
        .map(toTodoItem);
    },
  };
  const writer: TodoWriter = {
    async add(draft) {
      return toTodoItem(await store.add(newItem(draft, now())));
    },
  };
  ctx.provide(Contracts.todoRead, reader);
  ctx.provide(Contracts.todoWrite, writer);
}
