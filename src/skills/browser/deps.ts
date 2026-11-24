import type { BrowserAgent } from '../../core/contracts/index.js';
import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { AutoAuthSettings } from './auto-auth.js';
import type { LiveHub } from './live-hub.js';
import type { BrowserTexts } from './locale.js';
import type { BackgroundTasks } from '../work/background.js';

export interface BrowserSkillDeps {
  ctx: PluginContext;
  agent: BrowserAgent;
  texts: BrowserTexts;
  /** browser.task runs here, off the conversation turn, one at a time on this browser. */
  tasks: BackgroundTasks;
  /** Missing means auto-auth is off. */
  autoAuth?: AutoAuthSettings;
  /** Present when the adapter can open a page the owner drives from the app. */
  live?: LiveHub;
}

/** The owner can take the page over in the app: a live-capable adapter and the app channel are both there. */
export function liveInApp(deps: BrowserSkillDeps): boolean {
  return deps.live !== undefined && deps.ctx.tryUse(Contracts.appViews) !== undefined;
}
