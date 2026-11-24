import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { approvalAllows } from '../../core/policy/approval.js';
import type { ApprovalRecord } from '../../core/policy/approval.js';
import type { KeyValueStore } from '../../core/store/types.js';
import type { CompanyTask, TaskRepository } from './types.js';
import { FINAL_STATUSES, isOpen } from './types.js';

const KEY = 'tasks';
const MAX_TASKS = 500;
const MAX_REQUEST = 2000;
const MAX_TITLE = 120;

const effectSchema = z.enum(['read', 'write', 'send', 'pay', 'delete', 'system']);
const approvalSchema = z.object({
  approverKind: z.enum(['user', 'agent', 'policy']),
  approverId: z.string().min(1),
  effects: z.array(effectSchema),
  at: z.string(),
  note: z.string().optional(),
});
const stepSchema = z.object({ text: z.string(), output: z.string().optional() });
const taskSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{8}$/),
  team: z.string().min(1),
  title: z.string(),
  request: z.string(),
  source: z.enum(['owner', 'mail', 'event']),
  sourceRef: z.string().optional(),
  status: z.enum([
    'awaiting_accept',
    'queued',
    'planning',
    'running',
    'review',
    'awaiting_owner',
    'done',
    'failed',
    'closed',
  ]),
  steps: z.array(stepSchema),
  ownerEffects: z.array(effectSchema),
  result: z.string().optional(),
  reviewNote: z.string().optional(),
  revisions: z.number().int().min(0),
  approvals: z.array(approvalSchema),
  devJobId: z.string().optional(),
  closedReason: z.enum(['stale', 'owner_wait_expired', 'declined', 'review_failed', 'failed', 'cancelled']).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().optional(),
});

function newId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 8);
}

/** Oldest finished work goes first; open work is never silently dropped. */
function trim(tasks: CompanyTask[]): void {
  while (tasks.length > MAX_TASKS) {
    let dropIndex = -1;
    let dropCreatedAt = '';
    for (const [index, task] of tasks.entries()) {
      if (isOpen(task)) continue;
      if (dropIndex < 0 || task.createdAt < dropCreatedAt) {
        dropIndex = index;
        dropCreatedAt = task.createdAt;
      }
    }
    if (dropIndex < 0) return;
    tasks.splice(dropIndex, 1);
  }
}

/** Task list in this plugin's key-value namespace; malformed entries are dropped on read. */
export class KvTaskRepository implements TaskRepository {
  constructor(
    private readonly kv: KeyValueStore,
    private readonly now: () => Date,
  ) {}

  private async readAll(): Promise<CompanyTask[]> {
    const raw = await this.kv.get<unknown>(KEY);
    if (!Array.isArray(raw)) return [];
    const tasks: CompanyTask[] = [];
    for (const candidate of raw) {
      const parsed = taskSchema.safeParse(candidate);
      if (parsed.success) tasks.push(parsed.data as CompanyTask);
    }
    return tasks;
  }

  async all(): Promise<CompanyTask[]> {
    return this.readAll();
  }

  async get(id: string): Promise<CompanyTask | undefined> {
    return (await this.readAll()).find((task) => task.id === id);
  }

  async open(): Promise<CompanyTask[]> {
    return (await this.readAll()).filter((task) => isOpen(task));
  }

  async create(
    input: Pick<CompanyTask, 'team' | 'title' | 'request' | 'source' | 'status'> & { sourceRef?: string },
  ): Promise<CompanyTask> {
    const tasks = await this.readAll();
    const at = this.now().toISOString();
    const task: CompanyTask = {
      id: newId(),
      team: input.team,
      title: input.title.trim().slice(0, MAX_TITLE),
      request: input.request.trim().slice(0, MAX_REQUEST),
      source: input.source,
      ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
      status: input.status,
      steps: [],
      ownerEffects: [],
      revisions: 0,
      approvals: [],
      createdAt: at,
      updatedAt: at,
    };
    tasks.push(task);
    trim(tasks);
    await this.kv.set(KEY, tasks);
    return task;
  }

  async update(id: string, change: (task: CompanyTask) => CompanyTask): Promise<CompanyTask | undefined> {
    const tasks = await this.readAll();
    const index = tasks.findIndex((task) => task.id === id);
    const current = index < 0 ? undefined : tasks[index];
    if (current === undefined) return undefined;
    const changed = change(current);
    const at = this.now().toISOString();
    const next: CompanyTask = {
      ...changed,
      updatedAt: at,
      ...(FINAL_STATUSES.includes(changed.status) && changed.finishedAt === undefined ? { finishedAt: at } : {}),
    };
    tasks[index] = next;
    await this.kv.set(KEY, tasks);
    return next;
  }
}

/** Bots approve their own writes; send, pay and delete stay with the owner. */
export function recordApproval(task: CompanyTask, record: ApprovalRecord): CompanyTask {
  if (!approvalAllows(record.effects, record.approverKind)) {
    throw new Error('Only the owner can approve send, pay or delete');
  }
  return { ...task, approvals: [...task.approvals, record] };
}
