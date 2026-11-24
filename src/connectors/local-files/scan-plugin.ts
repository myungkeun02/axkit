import { homedir } from 'node:os';
import { Contracts } from '../../core/contracts/index.js';
import { composeFolderScanner } from '../../core/remote/compose.js';
import type { Plugin } from '../../core/plugin/types.js';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import type { ProcessRunner } from '../../core/process/types.js';
import { readLocalFilesSettings } from './config.js';
import type { LocalFs } from './fs.js';
import { nodeLocalFs } from './fs.js';
import { LocalFolderScanner } from './scanner.js';

export interface FolderScanConnectorOptions {
  /** Tests inject an in-memory tree; production uses node:fs/promises. */
  fs?: LocalFs;
  /** Tests inject a scripted runner; production runs real git. */
  run?: ProcessRunner;
  /** Test override for `~` expansion. */
  home?: string;
}

/** Connector for the first-run look at folders the owner chose. Read-only. */
export function folderScanConnector(opts: FolderScanConnectorOptions = {}): Plugin {
  return {
    manifest: {
      id: 'connector.folder-scan',
      kind: 'connector',
      title: 'Folder scan (first look)',
    },
    setup(ctx) {
      const { rules } = readLocalFilesSettings(ctx.config, ctx.log);
      const local = new LocalFolderScanner({
        fs: opts.fs ?? nodeLocalFs,
        run: opts.run ?? nodeProcessRunner,
        rules,
        home: opts.home ?? homedir(),
        log: ctx.log,
      });
      // Paired Macs (connector.remote-sources) join at run time; without any this is the local scanner.
      ctx.provide(Contracts.folderScan, composeFolderScanner(local, () => ctx.tryUse(Contracts.remoteSources)?.list() ?? [], ctx.log));
    },
  };
}
