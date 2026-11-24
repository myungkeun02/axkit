import type { SyncedTodo, SyncedTodoPatch, TodoSyncBackend } from '../../core/contracts/todo.js';
import type { Reminder, RemindersClient } from './client.js';
import { PERMISSION_HINT, RemindersError } from './client.js';

const EPOCH = new Date(0).toISOString();

/** A reminder as a synced to-do; one without a title is not a to-do. */
export function toSyncedTodo(reminder: Reminder): SyncedTodo | undefined {
  const text = reminder.title.trim();
  if (text === '') return undefined;
  const createdAt = reminder.createdAt ?? reminder.modifiedAt ?? EPOCH;
  return {
    id: reminder.id,
    text,
    done: reminder.done,
    createdAt,
    updatedAt: reminder.modifiedAt ?? createdAt,
    ...(reminder.due !== undefined ? { due: reminder.due } : {}),
    ...(reminder.done && reminder.completedAt !== undefined ? { completedAt: reminder.completedAt } : {}),
  };
}

function required(item: SyncedTodo | undefined): SyncedTodo {
  if (item === undefined) throw new RemindersError('helper', '미리 알림에 반영했지만 결과를 읽지 못했어요.');
  return item;
}

export interface AppleRemindersOptions {
  /** The Reminders list to sync with, by title; the default list for new reminders otherwise. */
  listName?: string;
}

/**
 * One Apple Reminders list as the to-do skill's two-way sync partner. Access is asked once (the macOS prompt) the
 * first time it is needed; after a refusal every call fails with the settings hint until the owner allows it.
 */
export class AppleReminders implements TodoSyncBackend {
  readonly label = 'apple-reminders';
  private allowed = false;
  private asked = false;
  private listId: string | undefined;

  constructor(
    private readonly client: RemindersClient,
    private readonly options: AppleRemindersOptions = {},
  ) {}

  async list(opts: { completedSince?: Date }): Promise<SyncedTodo[]> {
    const list = await this.resolveList();
    const since = opts.completedSince;
    const rows = await this.client.reminders({ list, ...(since !== undefined ? { doneSince: since } : {}) });
    return rows
      .filter((row) => {
        if (!row.done) return true;
        if (since === undefined || row.completedAt === undefined) return false;
        return new Date(row.completedAt).getTime() >= since.getTime();
      })
      .flatMap((row) => toSyncedTodo(row) ?? []);
  }

  async add(draft: { text: string; due?: string }): Promise<SyncedTodo> {
    const list = await this.resolveList();
    const created = await this.client.create({ list, title: draft.text, ...(draft.due !== undefined ? { due: draft.due } : {}) });
    return required(toSyncedTodo(created));
  }

  async update(id: string, patch: SyncedTodoPatch): Promise<SyncedTodo> {
    await this.access();
    const updated = await this.client.update(id, {
      ...(patch.text !== undefined ? { title: patch.text } : {}),
      ...(patch.due !== undefined ? { due: patch.due } : {}),
      ...(patch.done !== undefined ? { done: patch.done } : {}),
    });
    return required(toSyncedTodo(updated));
  }

  private async access(): Promise<void> {
    if (this.allowed) return;
    let status = await this.client.status();
    if (status === 'not-determined' && !this.asked) {
      this.asked = true;
      await this.client.request();
      status = await this.client.status();
    }
    if (status !== 'authorized') throw new RemindersError('permission', PERMISSION_HINT);
    this.allowed = true;
  }

  private async resolveList(): Promise<string> {
    await this.access();
    if (this.listId !== undefined) return this.listId;
    const lists = await this.client.lists();
    const wanted = this.options.listName?.normalize('NFC').trim();
    const found =
      wanted !== undefined && wanted !== ''
        ? lists.find((entry) => entry.title.normalize('NFC').trim() === wanted)
        : (lists.find((entry) => entry.default) ?? lists[0]);
    if (found === undefined) {
      throw new RemindersError(
        'no-list',
        wanted !== undefined && wanted !== '' ? `미리 알림에 '${wanted}' 목록이 없어요.` : '미리 알림 목록이 하나도 없어요.',
      );
    }
    this.listId = found.id;
    return found.id;
  }
}
