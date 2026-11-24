import type { AppFileShare } from '../../core/contracts/files.js';
import type { AppFiles } from './files.js';
import type { AppEventLog } from './log.js';

/** Capability "app.share-file": a file copied into the app's folder and posted in the main chat as an attachment. */
export function appFileShare(files: AppFiles, log: AppEventLog): AppFileShare {
  return {
    async send(file) {
      const attachment = await files.addDocument(file);
      await log.append({ type: 'message', role: 'assistant', text: file.text, attachments: [attachment] });
      return { id: attachment.id, name: attachment.name, contentType: attachment.contentType, size: attachment.size ?? 0 };
    },
  };
}
