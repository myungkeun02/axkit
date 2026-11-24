import { z } from 'zod';
import type { Tool } from '../../core/tools/types.js';
import type { WatchDeps } from './deps.js';
import { watchView } from './view.js';
import type { WatchView } from './view.js';

const input = z.object({});

export type WatchListInput = z.infer<typeof input>;

export interface WatchListOutput {
  count: number;
  message: string;
  watches: WatchView[];
}

export interface WatchListDeps extends WatchDeps {
  timeZone: string;
}

export function watchListTool(deps: WatchListDeps): Tool<WatchListInput, WatchListOutput> {
  return {
    name: 'watch.list',
    description: 'List watches with their last value and the next check time in the owner time zone.',
    input,
    effects: ['read'],
    async run() {
      const watches = deps.store.all().map((watch) =>
        watchView(watch, {
          texts: deps.texts,
          currency: deps.currency,
          timeZone: deps.timeZone,
        }),
      );
      return {
        count: watches.length,
        message: watches.length === 0 ? deps.texts.listEmpty : deps.texts.listHeader(watches.length),
        watches,
      };
    },
  };
}
