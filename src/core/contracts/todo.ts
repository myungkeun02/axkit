export interface TodoItem {
  id: string;
  text: string;
  /** ISO date "2026-11-20" or date-time with offset. */
  due?: string;
  /** When to remind, ISO date-time with offset. */
  remindAt?: string;
  done: boolean;
  createdAt: string;
  /** ISO date-time, set when the item was completed. */
  completedAt?: string;
  /** A short remark about the item's state, e.g. it vanished from a synced outside list and was kept here. */
  note?: string;
}

/** Capability "todo.read", provided by the to-do skill for others (the briefing). */
export interface TodoReader {
  open(): Promise<TodoItem[]>;
  /** Items completed at or after `since`. */
  doneSince(since: Date): Promise<TodoItem[]>;
}

export interface TodoDraft {
  text: string;
  due?: string;
  remindAt?: string;
}

/** Capability "todo.write". For skills that turn other input (a voice memo, an SMS) into to-dos. */
export interface TodoWriter {
  add(draft: TodoDraft): Promise<TodoItem>;
}

/**
 * Capability "todo.backend": an outside list (Google Tasks) the to-do skill keeps instead of its own store, so the
 * to-do tools, reminders and `todo.read`/`todo.write` work the same on either. Reminder times stay on this Mac.
 */
export interface TodoBackend {
  readonly label: string;
  /** Open items, plus items completed at or after `completedSince` when it is given. */
  list(opts: { completedSince?: Date }): Promise<TodoItem[]>;
  /** `due` is a date ("2026-11-20"); a time of day is not kept by the outside list. */
  add(draft: { text: string; due?: string }): Promise<TodoItem>;
  complete(id: string): Promise<TodoItem>;
  remove(id: string): Promise<void>;
}

/** An item on a list kept in two-way sync (Apple Reminders), with the time it last changed there. */
export interface SyncedTodo extends TodoItem {
  /** ISO date-time of the last change on the outside list. */
  updatedAt: string;
}

/** A change to one synced item. `due: null` clears the due date. */
export interface SyncedTodoPatch {
  text?: string;
  due?: string | null;
  done?: boolean;
}

/**
 * Capability "todo.sync": an outside list the to-do skill mirrors both ways (Apple Reminders). Unlike `todo.backend`,
 * the skill keeps its own list on this Mac and reconciles with this one periodically, so nothing is ever deleted on
 * one side just because it is missing on the other.
 */
export interface TodoSyncBackend {
  readonly label: string;
  /** Open items, plus items completed at or after `completedSince` when it is given. */
  list(opts: { completedSince?: Date }): Promise<SyncedTodo[]>;
  /** `due` is a date ("2026-11-20") or a date-time with offset. */
  add(draft: { text: string; due?: string }): Promise<SyncedTodo>;
  update(id: string, patch: SyncedTodoPatch): Promise<SyncedTodo>;
}
