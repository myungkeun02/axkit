import { z } from 'zod';
import type { TodoItem } from '../../core/contracts/index.js';
import type { Tool } from '../../core/tools/types.js';
import type { TodoTexts } from './locale.js';
import type { StoredTodo, TodoRepo } from './store.js';
import { toTodoItem } from './tools-shared.js';

const listInput = z.object({
  includeDone: z.boolean().optional().describe('Include completed items. Defaults to false.'),
});

const idInput = z.object({ id: z.string().min(1) });

export type TodoListInput = z.infer<typeof listInput>;
export type TodoIdInput = z.infer<typeof idInput>;

function byDueThenCreated(a: StoredTodo, b: StoredTodo): number {
  if (a.due !== undefined && b.due !== undefined) {
    return a.due.localeCompare(b.due) || a.createdAt.localeCompare(b.createdAt);
  }
  if (a.due !== undefined) return -1;
  if (b.due !== undefined) return 1;
  return a.createdAt.localeCompare(b.createdAt);
}

/** The item, fetching an outside list again when the id is not in the current copy. */
async function findItem(store: TodoRepo, id: string): Promise<StoredTodo | undefined> {
  const known = store.get(id);
  if (known !== undefined) return known;
  await store.sync(0);
  return store.get(id);
}

/** Tool "todo.list": dated items first by due date, then undated items by creation time. */
export function todoListTool(store: TodoRepo): Tool<TodoListInput, TodoItem[]> {
  return {
    name: 'todo.list',
    description: 'List the owner to-dos. Overdue and dated items come first, then undated items.',
    input: listInput,
    effects: ['read'],
    async run(input) {
      await store.sync(0);
      const includeDone = input.includeDone ?? false;
      return [...store.all()]
        .filter((item) => includeDone || !item.done)
        .sort(byDueThenCreated)
        .map(toTodoItem);
    },
  };
}

/** Tool "todo.complete": writes the owner's list. */
export function todoCompleteTool(store: TodoRepo, texts: TodoTexts, now: () => Date): Tool<TodoIdInput, TodoItem> {
  return {
    name: 'todo.complete',
    description: 'Mark one to-do as done.',
    input: idInput,
    effects: ['write'],
    describe(input) {
      const item = store.get(input.id);
      return `${texts.completeLabel}: ${item?.text ?? input.id}`;
    },
    async run(input) {
      const item = await findItem(store, input.id);
      if (item === undefined) throw new Error(`No to-do with id ${input.id}`);
      const done = item.done ? item : { ...item, done: true, completedAt: now().toISOString() };
      if (!item.done) await store.update(done);
      return toTodoItem(done);
    },
  };
}

/** Tool "todo.remove": deletion always needs the owner's approval, so describe shows the text. */
export function todoRemoveTool(store: TodoRepo, texts: TodoTexts): Tool<TodoIdInput, { id: string; removed: boolean }> {
  return {
    name: 'todo.remove',
    description: 'Delete one to-do permanently.',
    input: idInput,
    effects: ['delete'],
    describe(input) {
      const item = store.get(input.id);
      return `${texts.removeLabel}: ${item?.text ?? input.id}`;
    },
    async run(input) {
      await findItem(store, input.id);
      const removed = await store.remove(input.id);
      if (removed === undefined) throw new Error(`No to-do with id ${input.id}`);
      return { id: removed.id, removed: true };
    },
  };
}
