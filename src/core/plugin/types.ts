import type { EventBus } from '../events/types.js';
import type { Scheduler } from '../scheduler/types.js';
import type { SecretReader, SecretName } from '../secrets/types.js';
import type { LlmGateway } from '../llm/types.js';
import type { Logger } from '../log/types.js';
import type { Tool } from '../tools/types.js';
import type { MessageHandler, Replier } from '../conversation/types.js';
import type { Confirmer } from '../policy/types.js';
import type { ChannelRegistry } from '../hub/hub.js';
import type { KeyValueStore } from '../store/types.js';
import type { Clock } from '../scheduler/types.js';
import type { Toolbox } from '../tools/types.js';
import type { Capability } from './capability.js';
import { defineCapability } from './capability.js';

export type PluginKind = 'channel' | 'connector' | 'skill' | 'bridge';

export type { Capability } from './capability.js';
export { defineCapability } from './capability.js';

/** Optional OS/host requirements checked by `doctor` before a plugin starts. */
export interface Requirement {
  id: string;
  describe: string;
  check(): Promise<{ ok: boolean; hint?: string }>;
}

export interface PluginManifest {
  /** "channel.discord", "connector.google-calendar", "skill.briefing". */
  id: string;
  kind: PluginKind;
  /** One line for `ax-kit setup` and `/plugins`. */
  title: string;
  /** Keychain names this plugin may read. Reads of any other name throw. */
  secrets?: readonly SecretName[];
  /** Capabilities that must be provided by another enabled plugin before this one starts. */
  needs?: readonly Capability<unknown>[];
  requirements?: readonly Requirement[];
}

/** What a plugin receives. Everything is an interface; nothing concrete leaks in. */
export interface PluginContext {
  /** This plugin's own section of config.plugins (enabled flag included). */
  config: Readonly<Record<string, unknown>>;
  assistant: Readonly<{
    name: string;
    language: string;
    timezone: string;
    tone: 'polite' | 'formal' | 'casual';
    ownerName?: string;
  }>;
  secrets: SecretReader;
  bus: EventBus;
  scheduler: Scheduler;
  clock: Clock;
  llm: LlmGateway;
  log: Logger;
  /** Key-value storage namespaced to this plugin id. */
  kv: KeyValueStore;
  registerTool<I, O>(tool: Tool<I, O>): void;
  /** Every registered tool, behind the confirmation policy. For the assistant loop. */
  tools: Toolbox;
  registerHandler(handler: MessageHandler): void;
  provide<T>(cap: Capability<T>, impl: T): void;
  use<T>(cap: Capability<T>): T;
  /**
   * For optional capabilities. Call it at run time (in a handler or job), not in setup:
   * a provider set up after this plugin is not there yet during setup.
   */
  tryUse<T>(cap: Capability<T>): T | undefined;
}

export interface PluginInstance {
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface Plugin {
  manifest: PluginManifest;
  /** Wire up: register tools, handlers, jobs and capabilities. Long-running work belongs in start(). */
  setup(ctx: PluginContext): PluginInstance | void | Promise<PluginInstance | void>;
}

/**
 * Built-in channel capabilities. The app provides all three from one hub; channel plugins register an endpoint with
 * `channels` so the owner can use Discord, the phone app, or both.
 */
export const Caps = {
  replier: defineCapability<Replier>('core.replier'),
  confirmer: defineCapability<Confirmer>('core.confirmer'),
  channels: defineCapability<ChannelRegistry>('core.channels'),
} as const;
