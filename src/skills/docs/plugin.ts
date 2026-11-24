import { Contracts } from '../../core/contracts/index.js';
import type { Plugin } from '../../core/plugin/types.js';
import { docsTexts } from './locale.js';
import { mirrorDocs } from './mirror.js';
import type { MirrorFs } from './mirror.js';
import { docsListTool, docsShowTool, docsVerifyTool } from './tools.js';

export interface DocsSkillOptions {
  /** Folder for the Markdown view (inside the knowledge folder). Without it there is no file view. */
  dir?: string;
  fs?: MirrorFs;
}

const MIRROR_SECONDS = 3600;

/** Lets the owner read structured documents and clear review flags; the store itself is a core service. */
export function docsSkill(options: DocsSkillOptions = {}): Plugin {
  return {
    manifest: { id: 'skill.docs', kind: 'skill', title: 'Structured documents' },
    setup(ctx) {
      const texts = docsTexts(ctx.assistant.language);
      const deps = { docs: () => ctx.tryUse(Contracts.docs), texts };
      ctx.registerTool(docsListTool(deps));
      ctx.registerTool(docsShowTool(deps));
      ctx.registerTool(docsVerifyTool(deps));

      const dir = options.dir;
      if (dir === undefined) return;
      const mirror = async (): Promise<void> => {
        const docs = ctx.tryUse(Contracts.docs);
        if (docs === undefined) return;
        try {
          await mirrorDocs(docs, dir, texts.reviewLabel, options.fs);
        } catch (error) {
          ctx.log.warn('docs: markdown view not written', { error: error instanceof Error ? error.name : 'error' });
        }
      };
      ctx.scheduler.add({ name: 'docs.mirror', schedule: { kind: 'every', seconds: MIRROR_SECONDS }, run: mirror });
      ctx.bus.on('app.started', mirror);
    },
  };
}
