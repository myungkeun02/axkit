import { homedir } from 'node:os';
import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { readLocalFilesSettings } from './config.js';
import type { LocalFs } from './fs.js';
import { nodeLocalFs } from './fs.js';
import { LocalFilesSource } from './source.js';
import type { WatchFactory } from './watch.js';

export interface LocalFilesConnectorOptions {
  /** Tests inject an in-memory tree; production uses node:fs/promises. */
  fs?: LocalFs;
  /** Test override for `~` expansion. */
  home?: string;
  /** Tests inject a deterministic watcher and a short debounce. */
  watchFactory?: WatchFactory;
  debounceMs?: number;
}

/** Connector for text files under folders the owner lists in config. Read-only. */
export function localFilesConnector(opts: LocalFilesConnectorOptions = {}): Plugin {
  return {
    manifest: {
      id: 'connector.local-files',
      kind: 'connector',
      title: 'Local folders',
    },
    setup(ctx) {
      const settings = readLocalFilesSettings(ctx.config, ctx.log);
      if (settings.folders.length === 0) {
        ctx.log.warn('local-files: no folders configured; nothing will be listed');
      }
      ctx.provide(
        Contracts.filesLocal,
        new LocalFilesSource({
          fs: opts.fs ?? nodeLocalFs,
          folders: settings.folders,
          rules: settings.rules,
          includeHidden: settings.includeHidden,
          home: opts.home ?? homedir(),
          log: ctx.log,
          ...(opts.watchFactory !== undefined ? { watchFactory: opts.watchFactory } : {}),
          ...(opts.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
        }),
      );
    },
  };
}
