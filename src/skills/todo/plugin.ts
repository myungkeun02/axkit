import { Contracts } from '../../core/contracts/index.js';
import type { Plugin, PluginContext } from '../../core/plugin/types.js';
import { registerTodoButtons } from './buttons.js';
import { provideTodoCapabilities } from './capabilities.js';
import type { TodoTexts } from './locale.js';
import { todoTexts } from './locale.js';
import { RemoteTodoStore } from './remote-store.js';
import { registerTodoReminders } from './reminders.js';
import { TodoStore } from './store.js';
import type { TodoRepo } from './store.js';
import { SyncedTodoStore } from './synced-store.js';
import { todoAddTool } from './tools-add.js';
import { todoCompleteTool, todoListTool, todoRemoveTool } from './tools-items.js';

export const SYNC_JOB = 'todo.sync';
const SYNC_EVERY_SECONDS = 600;

export interface TodoSkillOptions {
  /**
   * Where items live: this Mac's store (default); an outside list provided as `todo.backend` (Google Tasks) that
   * replaces it; or this Mac's store kept in two-way sync with a `todo.sync` list (Apple Reminders) every 10 minutes.
   * Items in the local store stay there untouched while a `backend` list is used.
   */
  source?: 'local' | 'backend' | 'synced';
}

type LoadableRepo = TodoRepo & { load(): Promise<void> };

function storeFor(ctx: PluginContext, source: TodoSkillOptions['source'], texts: TodoTexts): LoadableRepo {
  const now = () => ctx.clock.now();
  if (source === 'backend') return new RemoteTodoStore(ctx.use(Contracts.todoBackend), ctx.kv, now);
  if (source !== 'synced') return new TodoStore(ctx.kv);
  const synced = new SyncedTodoStore({
    inner: new TodoStore(ctx.kv),
    backend: ctx.use(Contracts.todoSync),
    kv: ctx.kv,
    now,
    log: ctx.log,
    detachedNote: texts.detachedNote,
  });
  ctx.scheduler.add({
    name: SYNC_JOB,
    schedule: { kind: 'every', seconds: SYNC_EVERY_SECONDS },
    run: async () => {
      await synced.syncNow();
    },
  });
  return synced;
}

/** To-do skill: a small list in the plugin's key-value store, Google Tasks or Apple Reminders, with proactive reminders. */
export function todoSkill(options: TodoSkillOptions = {}): Plugin {
  const needs =
    options.source === 'backend' ? [Contracts.todoBackend] : options.source === 'synced' ? [Contracts.todoSync] : undefined;
  return {
    manifest: {
      id: 'skill.todo',
      kind: 'skill',
      title: 'To-do',
      ...(needs !== undefined ? { needs } : {}),
    },
    async setup(ctx) {
      const now = () => ctx.clock.now();
      const texts = todoTexts(ctx.assistant.language);
      const store = storeFor(ctx, options.source, texts);
      await store.load();

      ctx.registerTool(todoAddTool({ store, now, timeZone: ctx.assistant.timezone, texts }));
      ctx.registerTool(todoListTool(store));
      ctx.registerTool(todoCompleteTool(store, texts, now));
      ctx.registerTool(todoRemoveTool(store, texts));

      provideTodoCapabilities(ctx, store, now);
      registerTodoReminders(ctx, store, texts);
      registerTodoButtons(ctx, store, texts);
      if (!(store instanceof SyncedTodoStore)) return undefined;
      // A first reconcile right after start; a failure (no permission yet) is logged and the job tries again.
      return { start: () => store.sync(0) };
    },
  };
}
