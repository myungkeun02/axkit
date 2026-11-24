import type { WatchStore } from './store.js';
import type { MoneyCurrency } from './types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { WatchTexts } from './locale.js';

export interface WatchDeps {
  ctx: PluginContext;
  store: WatchStore;
  texts: WatchTexts;
  currency: MoneyCurrency;
}
