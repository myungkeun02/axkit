import { homedir } from 'node:os';
import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { nodeProcessRunner } from '../../core/process/node-runner.js';
import type { ProcessRunner } from '../../core/process/types.js';
import { driveView } from './drive-view.js';
import { fileChangesView, filesChangesTool } from './change-view.js';
import { ChangeLog } from './changes.js';
import { readFilesConfig } from './config.js';
import { filesFindTool } from './find.js';
import { registerFileIndex } from './index-job.js';
import { filesTexts } from './locale.js';
import { filesShareTool } from './share.js';
import { FileIndex } from './store.js';
import { filesReadTool, filesSearchTool } from './tools.js';
import { FileTracker } from './tracker.js';
import { FileSources } from './sources.js';

export interface FilesSkillOptions {
  /** Runs Spotlight (`mdfind`); tests inject a fake. */
  run?: ProcessRunner;
  /** Test override for the owner's home folder. */
  home?: string;
  /** Tests reach the tracker to wait for watched changes. */
  onTracker?: (tracker: FileTracker) => void;
}

/**
 * File skill: indexes the local folders and Drive folders the owner connected, keeps that index current (live
 * watching plus an hourly check), logs what changed, finds files anywhere in home with Spotlight and sends one to the
 * owner's own app. Sources are optional and resolved on every run; nothing is sent to a model.
 */
export function filesSkill(options: FilesSkillOptions = {}): Plugin {
  return {
    manifest: {
      id: 'skill.files',
      kind: 'skill',
      title: 'Files',
    },
    setup(ctx) {
      const config = readFilesConfig(ctx);
      const texts = filesTexts(ctx.assistant.language);
      const home = options.home ?? homedir();
      ctx.provide(Contracts.fileSources, new FileSources(ctx));
      const index = new FileIndex(ctx.kv);
      const changes = new ChangeLog(ctx.kv);
      const tracker = new FileTracker({ ctx, index, changes, home });
      options.onTracker?.(tracker);
      const watching = (): boolean => tracker.watching;
      const timeZone = ctx.assistant.timezone;

      registerFileIndex(ctx, config.indexSeconds, () => tracker.poll());
      ctx.registerTool(filesSearchTool({ index, timeZone }));
      ctx.registerTool(filesReadTool({ ctx, index, texts, home }));
      ctx.registerTool(filesChangesTool({ changes, clock: ctx.clock, timeZone, watching }));
      ctx.registerTool(filesFindTool({ run: options.run ?? nodeProcessRunner, home, timeZone, texts }));
      ctx.registerTool(filesShareTool({ ctx, home, texts }));

      ctx.bus.on('app.started', () => {
        const views = ctx.tryUse(Contracts.appViews);
        views?.register(fileChangesView({ changes, clock: ctx.clock, timeZone, watching }));
        views?.addFeature?.('file-changes');
        if (ctx.tryUse(Contracts.filesDrive) !== undefined) {
          views?.register(driveView({ sources: () => ctx.tryUse(Contracts.fileSources)?.list() ?? [], clock: ctx.clock, timeZone }));
          views?.addFeature?.('drive');
        }
      });

      return {
        async start() {
          await tracker.start();
        },
        async stop() {
          tracker.stop();
          await tracker.idle();
        },
      };
    },
  };
}
