import { z } from 'zod';
import type { Tool } from '../../core/tools/types.js';
import type { WatchDeps } from './deps.js';

const input = z.object({
  id: z.string().min(1).max(80).describe('Watch id from watch.list.'),
});

export type WatchRemoveInput = z.infer<typeof input>;

export type WatchRemoveOutput =
  | { status: 'removed'; id: string; label: string; message: string }
  | { status: 'not_found'; message: string };

export function watchRemoveTool(deps: WatchDeps): Tool<WatchRemoveInput, WatchRemoveOutput> {
  return {
    name: 'watch.remove',
    description: 'Stop watching and delete one watch permanently.',
    input,
    effects: ['delete'],
    describe(value) {
      const watch = deps.store.get(value.id);
      return deps.texts.removeDescription(watch?.label ?? value.id);
    },
    async run(value) {
      const removed = await deps.store.remove(value.id);
      if (removed === undefined) return { status: 'not_found', message: deps.texts.notFound(value.id) };
      return {
        status: 'removed',
        id: removed.id,
        label: removed.label,
        message: deps.texts.removed(removed.label),
      };
    },
  };
}
