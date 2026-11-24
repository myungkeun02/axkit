import type { Config, ConfigInput } from '../core/config/schema.js';
import { loadConfig, saveConfig } from '../core/config/load.js';
import { Contracts } from '../core/contracts/index.js';
import type { FeatureSetup } from '../core/contracts/feature-setup.js';
import type { Plugin } from '../core/plugin/types.js';

/** Plugins chat may turn on. Anything else still needs `ax-kit setup` (accounts, tokens, risky readers). */
export const SWITCHABLE = new Set(['skill.talent', 'connector.macos-ocr', 'skill.tuning', 'skill.onboarding', 'skill.dev-assist']);
const RESTART_DELAY_MS = 8_000;

export interface FeatureSetupOptions {
  configFile: string;
  /** Running under the login service (launchd brings it back after it exits). */
  managed: boolean;
  /** Ends this process gracefully; launchd starts it again. */
  restart: () => void;
  load?: (path: string) => Promise<Config>;
  save?: (path: string, config: ConfigInput) => Promise<void>;
  /** Tests: no real timer. */
  schedule?: (run: () => void, ms: number) => void;
}

/** Provides "core.feature-setup" for the running server. */
export function featureSetupPlugin(opts: FeatureSetupOptions): Plugin {
  return {
    manifest: { id: 'core.feature-setup', kind: 'skill', title: 'Feature setup from chat' },
    async setup(ctx) {
      const load = opts.load ?? loadConfig;
      const save = opts.save ?? saveConfig;
      const schedule = opts.schedule ?? ((run, ms) => void setTimeout(run, ms).unref());
      let current = await load(opts.configFile);
      let restarting = false;
      const setup: FeatureSetup = {
        isOn: (id) => current.plugins[id]?.['enabled'] === true,
        async turnOn(ids) {
          const allowed = ids.filter((id) => SWITCHABLE.has(id));
          if (allowed.length !== ids.length) throw new Error('Only switchable plugins can be turned on from chat.');
          // Read again: the owner may have run setup since this server started.
          current = await load(opts.configFile);
          const plugins = { ...current.plugins };
          for (const id of allowed) plugins[id] = { ...(plugins[id] ?? {}), enabled: true };
          await save(opts.configFile, {
            version: 1,
            assistant: current.assistant,
            owner: current.owner,
            channel: current.channel,
            policy: current.policy,
            llm: current.llm,
            plugins,
          });
          current = await load(opts.configFile);
          ctx.log.info('feature-setup: turned on from chat', { plugins: allowed.join(',') });
          if (!opts.managed) return { restart: 'manual' };
          if (!restarting) {
            restarting = true;
            schedule(opts.restart, RESTART_DELAY_MS);
          }
          return { restart: 'soon' };
        },
      };
      ctx.provide(Contracts.featureSetup, setup);
    },
  };
}
