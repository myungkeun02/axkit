import { z } from 'zod';
import { Contracts } from '../../core/contracts/index.js';
import { AppShareError } from '../../core/contracts/files.js';
import { extensionOf } from '../../core/files/filter.js';
import { SHARE_CONTENT_TYPES, SHARE_MAX_BYTES } from '../../core/files/share-types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { Tool } from '../../core/tools/types.js';
import { HomeFileError, resolveHomeFile } from './home-files.js';
import type { FilesTexts } from './locale.js';

const shareInput = z.object({
  path: z.string().trim().min(1).max(1_000).describe('The file to send, e.g. "~/Documents/a.pdf" from files.find.'),
});

export type FilesShareInput = z.infer<typeof shareInput>;

export interface FilesShareResult {
  name: string;
  size: number;
  contentType: string;
  note: string;
}

/**
 * Tool "files.share_to_app": copies one file under home into the app channel and posts it in the owner's chat.
 * Effect `write`: it only ever reaches the owner's own paired app, nobody else.
 */
export function filesShareTool(deps: { ctx: PluginContext; home: string; texts: FilesTexts }): Tool<FilesShareInput, FilesShareResult> {
  return {
    name: 'files.share_to_app',
    description:
      "Send one file from this Mac (pdf, picture, office document, txt/md, zip; up to 20 MB) to the owner's phone app, where it can be downloaded. Only to the owner.",
    input: shareInput,
    effects: ['write'],
    async run(input) {
      const share = deps.ctx.tryUse(Contracts.appShare);
      if (share === undefined) throw new Error(deps.texts.appMissing);
      let file;
      try {
        file = await resolveHomeFile(input.path, deps.home);
      } catch (error) {
        throw new Error(error instanceof HomeFileError ? deps.texts.homeFile[error.reason] : deps.texts.homeFile.missing);
      }
      if (SHARE_CONTENT_TYPES[extensionOf(file.name)] === undefined) throw new Error(deps.texts.homeFile.type);
      if (file.size === 0 || file.size > SHARE_MAX_BYTES) throw new Error(deps.texts.homeFile.size);
      let sent;
      try {
        sent = await share.send({ path: file.real, name: file.name, text: deps.texts.sharedText(file.name) });
      } catch (error) {
        throw new Error(error instanceof AppShareError ? deps.texts.shareFailed[error.reason] : deps.texts.shareFailed.unreadable);
      }
      return { name: sent.name, size: sent.size, contentType: sent.contentType, note: deps.texts.sharedNote };
    },
  };
}
