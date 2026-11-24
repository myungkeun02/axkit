import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { Tool } from '../../core/tools/types.js';
import { inverseChange } from './change.js';
import type { TuningTexts } from './locale.js';
import type { TuningStore } from './store.js';

const input = z.object({ id: z.string().min(1).max(40).describe('Applied change id from tuning.list.') });

export type TuningUndoInput = z.infer<typeof input>;

export interface TuningUndoOutput {
  status: 'ok' | 'not_found' | 'already_undone';
  message: string;
}

export interface TuningUndoDeps {
  ctx: PluginContext;
  store: TuningStore;
  texts: TuningTexts;
}

export function tuningUndoTool(deps: TuningUndoDeps): Tool<TuningUndoInput, TuningUndoOutput> {
  return {
    name: 'tuning.undo',
    description:
      'Undo an applied tuning change. A muted notice kind is turned back on, and the domain owner removes a ' +
      'learned rule. Does not contact anyone.',
    input,
    effects: ['write'],
    describe(value) {
      return deps.texts.undoDescription(value.id);
    },
    async run(value) {
      const record = await deps.store.appliedById(value.id);
      if (record === undefined) return { status: 'not_found', message: deps.texts.undoNotFound };
      if (record.undoneAt !== undefined) return { status: 'already_undone', message: deps.texts.undoAlready };

      const inverse = inverseChange(record.change);
      if (inverse.domain === 'notice') {
        const muter = deps.ctx.tryUse(Contracts.noticeMute);
        if (muter === undefined) {
          deps.ctx.log.warn('tuning: notice mute capability missing on undo', { subject: inverse.subject });
        } else if (inverse.action === 'unmute') {
          await muter.unmute(inverse.subject);
        } else {
          await muter.mute(inverse.subject);
        }
      }
      await deps.ctx.bus.emit('tuning.apply', inverse);
      await deps.store.markUndone(record.id, deps.ctx.clock.now().toISOString());
      return { status: 'ok', message: deps.texts.undoDone(record.change) };
    },
  };
}
