import { Contracts } from '../../core/contracts/index.js';
import type { Capability, Plugin } from '../../core/plugin/types.js';
import { workspaceTexts } from './locale.js';
import { contactsSearchTool } from './tools-contacts.js';
import { docsAppendTool, docsCreateTool, docsReadTool, docsReplaceTool } from './tools-docs.js';
import type { TitleCache } from './tools-docs.js';
import { sheetsAppendTool, sheetsReadTool, sheetsUpdateTool } from './tools-sheets.js';

/** Which Google Workspace parts are connected; the app reads this from the connector switches. */
export interface WorkspaceSkillOptions {
  docs?: boolean;
  /** "read" registers docs.read only; "edit" ("문서 고치기") adds docs.replace_text. Default "create". */
  docsLevel?: 'read' | 'create' | 'edit';
  sheets?: boolean;
  /** Sheets edits; only with the read-write Sheets scope. */
  sheetsWrite?: boolean;
  contacts?: boolean;
}

/**
 * Tools over Google Docs, Sheets and Contacts. Reads run freely and mark their content as data; every change goes
 * through an approval card that names the document or sheet and shows what goes in.
 */
export function workspaceSkill(options: WorkspaceSkillOptions): Plugin {
  const needs: Capability<unknown>[] = [];
  const docsLevel = options.docsLevel ?? 'create';
  if (options.docs === true) {
    needs.push(Contracts.docsRead);
    if (docsLevel !== 'read') needs.push(Contracts.docsWrite);
    if (docsLevel === 'edit') needs.push(Contracts.docsEdit);
  }
  if (options.sheets === true) needs.push(Contracts.sheetsRead);
  if (options.sheets === true && options.sheetsWrite === true) needs.push(Contracts.sheetsWrite);
  if (options.contacts === true) needs.push(Contracts.contactsRead);
  return {
    manifest: { id: 'skill.workspace', kind: 'skill', title: 'Google Docs · Sheets · Contacts', needs },
    setup(ctx) {
      const texts = workspaceTexts(ctx.assistant.language);
      const titles: TitleCache = new Map();
      if (options.docs === true) {
        ctx.registerTool(docsReadTool({ reader: ctx.use(Contracts.docsRead), texts, titles }));
        if (docsLevel !== 'read') {
          const writer = ctx.use(Contracts.docsWrite);
          ctx.registerTool(docsAppendTool({ writer, texts, titles, anyDoc: docsLevel === 'edit' }));
          ctx.registerTool(docsCreateTool({ writer, texts, titles }));
        }
        if (docsLevel === 'edit') ctx.registerTool(docsReplaceTool({ editor: ctx.use(Contracts.docsEdit), texts, titles }));
      }
      if (options.sheets === true) {
        ctx.registerTool(sheetsReadTool({ reader: ctx.use(Contracts.sheetsRead), texts, titles }));
        if (options.sheetsWrite === true) {
          const writer = ctx.use(Contracts.sheetsWrite);
          ctx.registerTool(sheetsAppendTool({ writer, texts, titles }));
          ctx.registerTool(sheetsUpdateTool({ writer, texts, titles }));
        }
      }
      if (options.contacts === true) {
        ctx.registerTool(contactsSearchTool({ reader: ctx.use(Contracts.contactsRead), texts }));
      }
    },
  };
}
