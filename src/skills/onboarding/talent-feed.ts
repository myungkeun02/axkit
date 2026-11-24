import { Contracts } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ScanItem } from './items.js';

/**
 * A file the summary called a résumé goes to the talent pack, when it is on and has not read this version yet. A
 * cached file is read again only for that. Failures never stop the first look.
 */
export async function feedTalent(
  ctx: PluginContext,
  item: ScanItem,
  docType: string | undefined,
  body: string | undefined,
  readBody: (item: ScanItem) => Promise<string | undefined>,
): Promise<void> {
  if (docType !== 'resume' || item.kind === 'repo' || item.kind === 'session') return;
  const intake = ctx.tryUse(Contracts.talentIntake);
  if (intake === undefined) return;
  try {
    if (!(await intake.wants(item.id, item.modifiedAt))) return;
    const text = body ?? (await readBody(item));
    if (text === undefined) return;
    await intake.add({ sourceId: item.id, path: item.path, source: item.source === 'drive' ? 'drive' : 'local', modifiedAt: item.modifiedAt, text });
  } catch (error) {
    ctx.log.warn('onboarding: a résumé could not go to the talent pack', { error: error instanceof Error ? error.name : 'unknown' });
  }
}
