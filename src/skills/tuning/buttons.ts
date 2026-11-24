import type { ConversationRef, HandleResult, MessageHandler, Replier } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import { applyChange } from './apply.js';
import type { TuningTexts } from './locale.js';
import { baselinePerWeek } from './measure.js';
import type { ImprovementRecord } from './record.js';
import type { TuningStore } from './store.js';
import type { Proposal } from './types.js';

export const TUNING_HANDLER = 'tuning.buttons';
export const TUNING_PRIORITY = 90;

const CHOICE = /^\(choice:\s*tuning\.(apply|skip):([A-Za-z0-9_-]{1,40})\)$/;
const DAY_MS = 86_400_000;
const BASELINE_DAYS = 14;

async function applyProposal(
  ctx: PluginContext,
  store: TuningStore,
  texts: TuningTexts,
  record: ImprovementRecord,
  proposal: Proposal,
  replier: Replier,
  conversation: ConversationRef,
): Promise<void> {
  const now = ctx.clock.now();
  await applyChange(ctx, proposal.change, now);

  const feedback = await store.since(new Date(now.getTime() - BASELINE_DAYS * DAY_MS));
  const feedbackBaseline = baselinePerWeek(feedback, proposal.change, now);
  const baseline = proposal.metric !== undefined && proposal.baseline !== undefined
    ? proposal.baseline
    : feedbackBaseline;
  await store.addApplied({
    id: proposal.id,
    change: proposal.change,
    appliedAt: now.toISOString(),
    baselinePerWeek: baseline,
    ...(proposal.metric !== undefined ? { metric: proposal.metric } : {}),
    ...(proposal.baseline !== undefined ? { baseline: proposal.baseline } : {}),
  });
  await store.setProposalStatus(proposal.id, 'applied');

  if (proposal.reason.kind === 'no_effect') {
    await store.markUndone(proposal.reason.of, now.toISOString());
    await record.reverted(proposal.change);
  } else {
    await record.applied(proposal.change);
  }
  await replier.reply(conversation, { text: texts.appliedReply(proposal.change) });
}

async function declineProposal(
  store: TuningStore,
  texts: TuningTexts,
  record: ImprovementRecord,
  proposal: Proposal,
  replier: Replier,
  conversation: ConversationRef,
): Promise<void> {
  await store.setProposalStatus(proposal.id, 'declined');
  await record.declined(proposal.change);
  await replier.reply(conversation, { text: texts.declinedReply(proposal.change) });
}

/** Owner presses only: nothing here applies a change without an explicit button press. */
export function registerButtons(
  ctx: PluginContext,
  store: TuningStore,
  texts: TuningTexts,
  record: ImprovementRecord,
): void {
  const handler: MessageHandler = {
    id: TUNING_HANDLER,
    priority: TUNING_PRIORITY,
    async handle(message, replier): Promise<HandleResult> {
      if (!message.fromOwner) return 'pass';
      const match = CHOICE.exec(message.text.trim());
      const action = match?.[1];
      const id = match?.[2];
      if (action === undefined || id === undefined) return 'pass';

      const proposal = await store.proposal(id);
      if (proposal === undefined || proposal.status !== 'open') {
        await replier.reply(message.conversation, { text: texts.unknownProposal });
        return 'handled';
      }
      if (action === 'apply') {
        await applyProposal(ctx, store, texts, record, proposal, replier, message.conversation);
      } else {
        await declineProposal(store, texts, record, proposal, replier, message.conversation);
      }
      return 'handled';
    },
  };
  ctx.registerHandler(handler);
}
