import type { Plugin } from '../../core/plugin/types.js';
import { readReceiptsConfig } from './config.js';
import { receiptsTexts } from './locale.js';
import { registerMonthEnd } from './monthend.js';
import { registerReadFileTool } from './read-file.js';
import { registerScan } from './scan.js';
import { registerDocsTools } from './tools.js';
import type { VaultFs } from './vault.js';
import { Vault } from './vault.js';

export interface ReceiptsSkillOptions {
  /** Absolute folder for mail copies and attachments. Without it the index is still kept. */
  vaultDir?: string;
  /** Tests inject a recording fake; production uses node:fs/promises. */
  fs?: VaultFs;
}

/**
 * Receipts and documents skill: copies document mail and attachments into a private vault, keeps a monthly index,
 * and reports at month end which charges have no mail receipt.
 */
export function receiptsSkill(options: ReceiptsSkillOptions = {}): Plugin {
  return {
    manifest: {
      id: 'skill.receipts',
      kind: 'skill',
      title: 'Receipts and documents',
    },
    setup(ctx) {
      const config = readReceiptsConfig(ctx);
      const texts = receiptsTexts(ctx.assistant.language);
      const vault = new Vault({
        ...(options.vaultDir !== undefined ? { vaultDir: options.vaultDir } : {}),
        ...(options.fs !== undefined ? { fs: options.fs } : {}),
      });

      registerDocsTools(ctx, texts);
      registerReadFileTool(ctx, vault);
      registerMonthEnd(ctx, { config, texts });
      if (config.scan) registerScan(ctx, { vault, texts });
    },
  };
}
