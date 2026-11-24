import type { PluginContext } from '../../core/plugin/types.js';
import type { ChatInboxConfig } from './config.js';
import type { ChatInboxTexts } from './locale.js';
import type { ChatInboxStore } from './store.js';

export interface ChatInboxDeps {
  ctx: PluginContext;
  store: ChatInboxStore;
  texts: ChatInboxTexts;
  config: ChatInboxConfig;
}
