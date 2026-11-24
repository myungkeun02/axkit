import type { Config } from '../config/schema.js';
import type { EventBus } from '../events/types.js';
import type { Scheduler } from '../scheduler/types.js';
import type { SecretReader } from '../secrets/types.js';
import type { LlmGateway } from '../llm/types.js';
import type { Logger } from '../log/types.js';
import type { Tool, Toolbox, ToolRegistry } from '../tools/types.js';
import type { Clock } from '../scheduler/types.js';
import type { MessageHandler } from '../conversation/types.js';
import type { KeyValueStore } from '../store/types.js';
import type { Capability, Plugin, PluginContext, PluginInstance } from './types.js';
import { scopedReader } from '../secrets/scoped.js';

interface PluginHostOptions {
  config: Config;
  secrets: SecretReader;
  bus: EventBus;
  scheduler: Scheduler;
  llm: LlmGateway;
  log: Logger;
  tools: ToolRegistry;
  toolbox: Toolbox;
  clock: Clock;
  kv: (namespace: string) => KeyValueStore;
}

interface PluginRecord {
  plugin: Plugin;
  instance: PluginInstance | undefined;
  setupDone: boolean;
  started: boolean;
}

export class PluginHost {
  private readonly records = new Map<string, PluginRecord>();
  private readonly capabilities = new Map<string, unknown>();
  private readonly handlerList: MessageHandler[] = [];
  private readonly setupOrder: PluginRecord[] = [];

  constructor(private readonly opts: PluginHostOptions) {}

  add(plugin: Plugin): void {
    const id = plugin.manifest.id;
    if (this.records.has(id)) throw new Error(`Duplicate plugin id: ${id}`);
    this.records.set(id, { plugin, instance: undefined, setupDone: false, started: false });
  }

  /** For services the app builds itself (the notifier), before plugins are set up. */
  provide<T>(cap: Capability<T>, impl: T): void {
    if (this.capabilities.has(cap.id)) throw new Error(`Capability already provided: ${cap.id}`);
    this.capabilities.set(cap.id, impl);
  }

  isEnabled(id: string): boolean {
    return this.opts.config.plugins[id]?.enabled !== false;
  }

  async setupAll(): Promise<void> {
    const pending = [...this.records.values()].filter(
      (record) => !record.setupDone && this.isEnabled(record.plugin.manifest.id),
    );

    while (pending.length > 0) {
      let progress = false;
      for (let index = 0; index < pending.length; ) {
        const record = pending[index];
        if (record === undefined) break;
        if (this.missing(record.plugin).length > 0) {
          index += 1;
          continue;
        }
        await this.setupOne(record);
        record.setupDone = true;
        this.setupOrder.push(record);
        pending.splice(index, 1);
        progress = true;
      }
      if (!progress) {
        const lines = pending.map((record) => {
          const missing = this.missing(record.plugin).join(', ');
          return `- ${record.plugin.manifest.id}: missing ${missing}`;
        });
        throw new Error(`Cannot set up plugins:\n${lines.join('\n')}`);
      }
    }
  }

  async startAll(): Promise<void> {
    for (const record of this.setupOrder) {
      await record.instance?.start?.();
      record.started = true;
    }
  }

  async stopAll(): Promise<void> {
    for (const record of [...this.setupOrder].reverse()) {
      if (!record.started) continue;
      try {
        await record.instance?.stop?.();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.opts.log.error('plugin stop failed', { plugin: record.plugin.manifest.id, error: message });
      }
      record.started = false;
    }
  }

  handlers(): MessageHandler[] {
    return [...this.handlerList].sort((a, b) => b.priority - a.priority);
  }

  capability<T>(cap: Capability<T>): T | undefined {
    return this.capabilities.get(cap.id) as T | undefined;
  }

  plugins(): { id: string; kind: string; title: string; enabled: boolean; started: boolean }[] {
    return [...this.records.values()].map((record) => ({
      id: record.plugin.manifest.id,
      kind: record.plugin.manifest.kind,
      title: record.plugin.manifest.title,
      enabled: this.isEnabled(record.plugin.manifest.id),
      started: record.started,
    }));
  }

  private missing(plugin: Plugin): string[] {
    return (plugin.manifest.needs ?? [])
      .filter((cap) => !this.capabilities.has(cap.id))
      .map((cap) => cap.id);
  }

  private async setupOne(record: PluginRecord): Promise<void> {
    const context = this.createContext(record.plugin);
    const result = await record.plugin.setup(context);
    if (result !== undefined) record.instance = result;
  }

  private createContext(plugin: Plugin): PluginContext {
    const id = plugin.manifest.id;
    return {
      config: this.opts.config.plugins[id] ?? {},
      assistant: {
        name: this.opts.config.assistant.name,
        language: this.opts.config.assistant.language,
        timezone: this.opts.config.assistant.timezone,
        tone: this.opts.config.assistant.tone,
        ...(this.opts.config.assistant.ownerName !== undefined
          ? { ownerName: this.opts.config.assistant.ownerName }
          : {}),
      },
      secrets: scopedReader(this.opts.secrets, plugin.manifest.secrets ?? [], id),
      bus: this.opts.bus,
      scheduler: this.opts.scheduler,
      clock: this.opts.clock,
      llm: this.opts.llm,
      log: this.opts.log.child(id),
      kv: this.opts.kv(id),
      registerTool: <I, O>(tool: Tool<I, O>): void => {
        this.opts.tools.register(tool);
      },
      tools: this.opts.toolbox,
      registerHandler: (handler: MessageHandler): void => {
        this.handlerList.push(handler);
      },
      provide: <T>(cap: Capability<T>, impl: T): void => {
        this.provide(cap, impl);
      },
      use: <T>(cap: Capability<T>): T => {
        if (!this.capabilities.has(cap.id)) {
          throw new Error(`Capability not available: ${cap.id}`);
        }
        return this.capabilities.get(cap.id) as T;
      },
      tryUse: <T>(cap: Capability<T>): T | undefined => this.capabilities.get(cap.id) as T | undefined,
    };
  }
}
