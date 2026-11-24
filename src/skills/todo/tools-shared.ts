import type { TodoItem } from '../../core/contracts/index.js';
import type { TodoTexts } from './locale.js';
import type { StoredTodo } from './store.js';

/** Strips the plugin's internal bookkeeping before the model or another skill sees an item. */
export function toTodoItem(item: StoredTodo): TodoItem {
  return {
    id: item.id,
    text: item.text,
    done: item.done,
    createdAt: item.createdAt,
    ...(item.due !== undefined ? { due: item.due } : {}),
    ...(item.remindAt !== undefined ? { remindAt: item.remindAt } : {}),
    ...(item.completedAt !== undefined ? { completedAt: item.completedAt } : {}),
    ...(item.note !== undefined ? { note: item.note } : {}),
  };
}

/** Short id that is easy to show in a button or a confirmation card. */
export function newTodoId(): string {
  return crypto.randomUUID().slice(0, 8);
}

/** Localized reason for an approval card, or undefined when nothing was guessed. */
export function guessNote(guesses: readonly string[], texts: TodoTexts): string | undefined {
  if (guesses.length === 0) return undefined;
  const labels = guesses.map((guess) => texts.guesses[guess] ?? texts.uncertain);
  return [...new Set(labels)].join('; ');
}
