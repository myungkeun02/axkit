import { Contracts } from '../../core/contracts/index.js';
import type { DocAuthor, DocStore, TuningChange } from '../../core/contracts/index.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { TuningTexts } from './locale.js';

export const RECORD_DOC_ID = 'tuning:improvements';

const AGENT: DocAuthor = { kind: 'agent', id: 'skill.tuning' };
const OWNER: DocAuthor = { kind: 'user', id: 'owner' };
const SOURCES = ['tuning:weekly'] as const;

/**
 * Writes the '개선 기록' document: every proposal, approval, measurement and revert, so the loop can be
 * judged later instead of only counted like the original assistant's 715 unmeasured "improvements".
 */
export class ImprovementRecord {
  constructor(
    private readonly ctx: PluginContext,
    private readonly texts: TuningTexts,
  ) {}

  private async append(text: string, author: DocAuthor): Promise<void> {
    const docs: DocStore | undefined = this.ctx.tryUse(Contracts.docs);
    if (docs === undefined) return;
    try {
      const existing = await docs.get(RECORD_DOC_ID);
      if (existing === undefined) {
        await docs.upsert({
          id: RECORD_DOC_ID,
          kind: 'improvement',
          scope: 'assistant',
          title: this.texts.recordTitle,
          body: this.texts.recordBody,
          author: AGENT,
        });
      }
      await docs.append(RECORD_DOC_ID, { text, author, sources: [...SOURCES] });
    } catch {
      // The improvement log is useful but must never take the weekly notice down with it.
      this.ctx.log.warn('tuning: improvement log write skipped');
    }
  }

  proposed(reason: string): Promise<void> {
    return this.append(this.texts.recordProposed(reason), AGENT);
  }

  applied(change: TuningChange): Promise<void> {
    return this.append(this.texts.recordApplied(change), OWNER);
  }

  declined(change: TuningChange): Promise<void> {
    return this.append(this.texts.recordDeclined(change), OWNER);
  }

  measured(change: TuningChange, baseline: number, after: number, effective: boolean): Promise<void> {
    return this.append(this.texts.recordMeasured(change, baseline, after, effective), AGENT);
  }

  reverted(change: TuningChange): Promise<void> {
    return this.append(this.texts.recordReverted(change), OWNER);
  }
}
