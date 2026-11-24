import { z } from 'zod';
import type { AppView, WorkItem } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import type { Tool } from '../../core/tools/types.js';
import { KvWorkBoard } from './board.js';
import { elapsedMinutes, workTexts } from './texts.js';
import type { WorkTexts } from './texts.js';

const DEFAULT_RECENT = 5;

const statusInput = z.object({
  recent: z.number().int().min(0).max(20).optional().describe('How many recently finished tasks to include (default 5).'),
});
type StatusInput = z.infer<typeof statusInput>;

export interface WorkEntryView extends WorkItem {
  elapsedMinutes: number;
}

export interface WorkStatusOutput {
  message: string;
  active: WorkEntryView[];
  recent: WorkEntryView[];
}

async function overview(board: KvWorkBoard, texts: WorkTexts, now: Date, recentCount: number): Promise<WorkStatusOutput> {
  const { active, finished } = board.split();
  const recent = finished.slice(0, recentCount);
  const view = (item: WorkItem): WorkEntryView => ({ ...item, elapsedMinutes: elapsedMinutes(item, now) });
  return { message: texts.overview(active, recent, now), active: active.map(view), recent: recent.map(view) };
}

export function workStatusTool(board: KvWorkBoard, texts: WorkTexts, now: () => Date): Tool<StatusInput, WorkStatusOutput> {
  return {
    name: 'work.status',
    description:
      'What the assistant is working on right now and what finished recently: dev jobs, browser tasks, errands and ' +
      'other long tasks, with status, current step, elapsed minutes and the outcome. Use it whenever the owner asks ' +
      '"어떻게 됐어?", "다 했어?", "뭐 하고 있어?" about something started earlier.',
    input: statusInput,
    effects: ['read'],
    run: (value) => overview(board, texts, now(), value.recent ?? DEFAULT_RECENT),
  };
}

/** Read-only app view `work` (docs/APP-PROTOCOL.md §28). */
export function workView(board: KvWorkBoard, texts: WorkTexts, now: () => Date): AppView {
  return {
    name: 'work',
    version: 1,
    async read() {
      const output = await overview(board, texts, now(), 20);
      return { title: texts.viewTitle, ...output };
    },
  };
}

/** The owner's unified "지금 하고 있는 일 / 최근에 끝난 일" list, which long-running features register into. */
export function workSkill(): Plugin {
  return {
    manifest: { id: 'skill.work', kind: 'skill', title: 'Work in progress (what the assistant is doing)' },
    async setup(ctx) {
      const now = (): Date => ctx.clock.now();
      const board = new KvWorkBoard(ctx.kv, now);
      await board.load();
      const texts = workTexts(ctx.assistant.language);
      ctx.provide(Contracts.workInProgress, board);
      ctx.registerTool(workStatusTool(board, texts, now));
      ctx.bus.on('app.started', () => {
        ctx.tryUse(Contracts.appViews)?.register(workView(board, texts, now));
      });
    },
  };
}
