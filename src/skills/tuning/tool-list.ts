import { z } from 'zod';
import type { TuningChange } from '../../core/contracts/index.js';
import type { Tool } from '../../core/tools/types.js';
import type { TuningTexts } from './locale.js';
import type { TuningStore } from './store.js';

const input = z.object({});

export type TuningListInput = z.infer<typeof input>;

export interface TuningOpenView {
  id: string;
  change: TuningChange;
  reason: string;
}

export interface TuningAppliedView {
  id: string;
  change: TuningChange;
  baselinePerWeek: number;
  afterPerWeek?: number;
  measuredAt?: string;
  undone: boolean;
}

export interface TuningListView {
  count: number;
  message: string;
  open: TuningOpenView[];
  applied: TuningAppliedView[];
}

export interface TuningListDeps {
  store: TuningStore;
  texts: TuningTexts;
}

export function tuningListTool(deps: TuningListDeps): Tool<TuningListInput, TuningListView> {
  return {
    name: 'tuning.list',
    description: 'List open self-tuning proposals and applied changes with their measured effect.',
    input,
    effects: ['read'],
    async run() {
      const open: TuningOpenView[] = (await deps.store.proposals())
        .filter((proposal) => proposal.status === 'open')
        .map((proposal) => ({
          id: proposal.id,
          change: proposal.change,
          reason: deps.texts.proposalReason(proposal.reason, proposal.change.subject),
        }));
      const records = await deps.store.applied();
      const applied: TuningAppliedView[] = records.map((record) => ({
        id: record.id,
        change: record.change,
        baselinePerWeek: record.baselinePerWeek,
        ...(record.measured !== undefined
          ? { afterPerWeek: record.measured.afterPerWeek, measuredAt: record.measured.at }
          : {}),
        undone: record.undoneAt !== undefined,
      }));

      const lines = [
        ...open.map((item) => deps.texts.openLine(item.id, item.reason)),
        ...records.map((record) =>
          deps.texts.appliedLine(
            record.id,
            record.change,
            record.baselinePerWeek,
            record.measured,
            record.undoneAt !== undefined,
          ),
        ),
      ];
      return {
        count: open.length + applied.length,
        message:
          lines.length === 0
            ? deps.texts.listEmpty
            : [deps.texts.listTitle, ...lines.map((line) => `- ${line}`)].join('\n'),
        open,
        applied,
      };
    },
  };
}
