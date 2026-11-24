import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import type { ProcessRunner } from '../../core/process/types.js';
import type { KeyValueStore } from '../../core/store/types.js';
import type { AxReader } from './reader.js';
import { HelperAxReader, swiftHelperPath } from './reader.js';

export interface ScreenChatFs {
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
}

export interface ScreenChatOptions {
  binDir?: string;
  run?: ProcessRunner;
  reader?: AxReader;
  home?: string;
  fs?: ScreenChatFs;
}

export interface ScreenChatDeps {
  run: ProcessRunner;
  reader: AxReader;
  home: string;
  fs: ScreenChatFs;
}

export interface ScreenChatConfig {
  pollSeconds: number;
  listLimit: number;
}

const ConfigSchema = z.object({
  pollSeconds: z.number().int().min(60).default(300),
  listLimit: z.number().int().min(1).max(100).default(30),
});

const DEFAULT_CONFIG: ScreenChatConfig = { pollSeconds: 300, listLimit: 30 };

const defaultFs: ScreenChatFs = {
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
  listDir: (path) => readdir(path),
};

/** Resolves every outside dependency once, so plugin setup stays small and tests inject fakes. */
export function screenChatDeps(options: ScreenChatOptions = {}): ScreenChatDeps {
  const home = options.home ?? homedir();
  const run = options.run ?? nodeProcessRunner;
  const reader =
    options.reader ??
    new HelperAxReader({
      run,
      helperPath: swiftHelperPath(options.binDir ?? join(home, '.ax-kit', 'bin'), run),
    });
  return { run, reader, home, fs: options.fs ?? defaultFs };
}

export function screenChatConfig(raw: Readonly<Record<string, unknown>>): ScreenChatConfig {
  const parsed = ConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_CONFIG;
}

/** Gives each tracker its own `seen` key inside the plugin's key-value namespace. */
export function scopedKv(inner: KeyValueStore, prefix: string): KeyValueStore {
  const scoped = (key: string): string => `${prefix}:${key}`;
  return {
    get: <T>(key: string) => inner.get<T>(scoped(key)),
    set: <T>(key: string, value: T) => inner.set(scoped(key), value),
    delete: (key: string) => inner.delete(scoped(key)),
  };
}
