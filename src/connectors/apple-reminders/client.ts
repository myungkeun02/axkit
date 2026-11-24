import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ensureSwiftHelper } from '../../core/process/swift-helper.js';
import type { ProcessRunner, RunResult } from '../../core/process/types.js';

const TIMEOUT_MS = 60_000;
/** The permission prompt waits for the owner, so the request command gets longer. */
const REQUEST_TIMEOUT_MS = 150_000;

export type RemindersAccess = 'authorized' | 'not-determined' | 'denied' | 'restricted' | 'write-only' | 'unknown';

export interface ReminderList {
  id: string;
  title: string;
  default: boolean;
  writable: boolean;
}

export interface Reminder {
  id: string;
  list: string;
  title: string;
  done: boolean;
  /** "2026-11-20" or a date-time with offset when the reminder has a time. */
  due?: string;
  completedAt?: string;
  createdAt?: string;
  modifiedAt?: string;
}

export interface ReminderPatch {
  title?: string;
  /** null clears the due date. */
  due?: string | null;
  done?: boolean;
}

export const PERMISSION_HINT =
  '미리 알림 접근이 허용되지 않았어요. 시스템 설정 > 개인정보 보호 및 보안 > 미리 알림에서 ax-kit을 실행하는 앱(터미널 또는 node)을 켜 주세요.';

export class RemindersError extends Error {
  constructor(
    readonly code: 'permission' | 'not-found' | 'no-list' | 'helper' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'RemindersError';
  }
}

const Access = z.enum(['authorized', 'not-determined', 'denied', 'restricted', 'write-only', 'unknown']);
const Failed = z.object({ ok: z.literal(false), error: z.string(), status: z.string().optional() });
const Status = z.object({ ok: z.literal(true), status: Access });
const Request = z.object({ ok: z.literal(true), granted: z.boolean(), status: Access });
const List = z.object({ id: z.string(), title: z.string(), default: z.boolean(), writable: z.boolean() });
const Lists = z.object({ ok: z.literal(true), lists: z.array(List) });
const Row = z.object({
  id: z.string().min(1),
  list: z.string(),
  title: z.string(),
  done: z.boolean(),
  due: z.string().optional(),
  completedAt: z.string().optional(),
  createdAt: z.string().optional(),
  modifiedAt: z.string().optional(),
});
const Rows = z.object({ ok: z.literal(true), reminders: z.array(Row) });
const One = z.object({ ok: z.literal(true), reminder: Row });

/** The helper's commands; each call is one process run. */
export interface RemindersClient {
  status(): Promise<RemindersAccess>;
  /** Shows the macOS prompt once; resolves true when access is allowed. */
  request(): Promise<boolean>;
  lists(): Promise<ReminderList[]>;
  reminders(opts: { list?: string; since?: Date; doneSince?: Date }): Promise<Reminder[]>;
  create(draft: { list?: string; title: string; due?: string }): Promise<Reminder>;
  complete(id: string): Promise<Reminder>;
  update(id: string, patch: ReminderPatch): Promise<Reminder>;
}

function strip(row: z.infer<typeof Row>): Reminder {
  const { due, completedAt, createdAt, modifiedAt, ...base } = row;
  return {
    ...base,
    ...(due !== undefined ? { due } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(modifiedAt !== undefined ? { modifiedAt } : {}),
  };
}

export interface HelperRemindersClientOptions {
  run: ProcessRunner;
  helperPath: () => Promise<string>;
}

export class HelperRemindersClient implements RemindersClient {
  constructor(private readonly options: HelperRemindersClientOptions) {}

  async status(): Promise<RemindersAccess> {
    return this.parse(await this.call(['status']), Status).status;
  }

  async request(): Promise<boolean> {
    return this.parse(await this.call(['request'], REQUEST_TIMEOUT_MS), Request).granted;
  }

  async lists(): Promise<ReminderList[]> {
    return this.parse(await this.call(['lists']), Lists).lists;
  }

  async reminders(opts: { list?: string; since?: Date; doneSince?: Date }): Promise<Reminder[]> {
    const args = ['reminders'];
    if (opts.list !== undefined) args.push('--list', opts.list);
    if (opts.since !== undefined) args.push('--since', opts.since.toISOString());
    if (opts.doneSince !== undefined) args.push('--done-since', opts.doneSince.toISOString());
    return this.parse(await this.call(args), Rows).reminders.map(strip);
  }

  async create(draft: { list?: string; title: string; due?: string }): Promise<Reminder> {
    const args = ['create', '--title', draft.title];
    if (draft.list !== undefined) args.push('--list', draft.list);
    if (draft.due !== undefined) args.push('--due', draft.due);
    return strip(this.parse(await this.call(args), One).reminder);
  }

  async complete(id: string): Promise<Reminder> {
    return strip(this.parse(await this.call(['complete', '--id', id]), One).reminder);
  }

  async update(id: string, patch: ReminderPatch): Promise<Reminder> {
    const args = ['update', '--id', id];
    if (patch.title !== undefined) args.push('--title', patch.title);
    if (patch.due === null) args.push('--clear-due', '1');
    else if (patch.due !== undefined) args.push('--due', patch.due);
    if (patch.done !== undefined) args.push('--done', patch.done ? '1' : '0');
    return strip(this.parse(await this.call(args), One).reminder);
  }

  private async call(args: readonly string[], timeoutMs = TIMEOUT_MS): Promise<unknown> {
    const helper = await this.options.helperPath();
    let result: RunResult;
    try {
      result = await this.options.run(helper, args, { timeoutMs });
    } catch (error) {
      throw new RemindersError('helper', `미리 알림 도우미를 실행하지 못했어요: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (result.timedOut) throw new RemindersError('timeout', '미리 알림 도우미가 제때 답하지 않았어요.');
    if (result.code !== 0) throw new RemindersError('helper', `미리 알림 도우미가 실패했어요 (exit ${result.code}).`);
    try {
      return JSON.parse(result.stdout);
    } catch {
      throw new RemindersError('helper', '미리 알림 도우미가 잘못된 답을 줬어요.');
    }
  }

  private parse<T>(raw: unknown, schema: z.ZodType<T>): T {
    const failed = Failed.safeParse(raw);
    if (failed.success) {
      const { error } = failed.data;
      if (error === 'permission') throw new RemindersError('permission', PERMISSION_HINT);
      if (error === 'not-found') throw new RemindersError('not-found', '그 미리 알림을 찾지 못했어요.');
      if (error === 'no-list') throw new RemindersError('no-list', '미리 알림 목록을 찾지 못했어요.');
      throw new RemindersError('helper', `미리 알림 도우미 오류: ${error}`);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new RemindersError('helper', '미리 알림 도우미가 예상하지 못한 답을 줬어요.');
    return parsed.data;
  }
}

/** Memoized compile of reminders.swift with EventKit and the usage-description Info.plist. */
export function remindersHelperPath(binDir: string, run: ProcessRunner): () => Promise<string> {
  let pending: Promise<string> | undefined;
  return () => {
    pending ??= ensureSwiftHelper(
      {
        name: 'ax-reminders',
        sourcePath: fileURLToPath(new URL('./reminders.swift', import.meta.url)),
        infoPlistPath: fileURLToPath(new URL('./reminders-Info.plist', import.meta.url)),
        binDir,
        frameworks: ['EventKit'],
      },
      { run },
    ).catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
}
