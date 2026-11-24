import { Contracts } from '../../core/contracts/index.js';
import type { HandleResult, MessageHandler } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { WorkTexts } from './locale-work.js';
import { recordApproval } from './store.js';
import { logDecision } from './team-docs.js';
import type { CompanyTask, TaskRepository } from './types.js';

const CHOICE = /^\(choice:\s*company\.(approve|decline):([a-f0-9]{8})\)$/;

export interface DecisionDeps {
  ctx: PluginContext;
  repo: TaskRepository;
  texts: WorkTexts;
}

async function log(
  deps: DecisionDeps,
  task: CompanyTask,
  text: string,
): Promise<void> {
  const docs = deps.ctx.tryUse(Contracts.docs);
  if (docs === undefined) return;
  await logDecision(docs, task.team, text, { kind: 'user', id: 'owner' }, [`task:${task.id}`]);
}

/** Owner buttons for work waiting on send/pay/delete: approving records the owner's decision, nothing more. */
export function decisionHandler(deps: DecisionDeps): MessageHandler {
  return {
    id: 'company.decision',
    priority: 61,
    async handle(message, replier): Promise<HandleResult> {
      if (!message.fromOwner) return 'pass';
      const match = CHOICE.exec(message.text.trim());
      if (match === null) return 'pass';

      const action = match[1] ?? '';
      const id = match[2] ?? '';
      const task = await deps.repo.get(id);
      if (task === undefined || task.status !== 'awaiting_owner') {
        await replier.reply(message.conversation, { text: deps.texts.decisionUnknown });
        return 'handled';
      }

      const at = deps.ctx.clock.now().toISOString();
      if (action === 'approve') {
        const updated = await deps.repo.update(id, (current) => ({
          ...recordApproval(current, {
            approverKind: 'user',
            approverId: 'owner',
            effects: current.ownerEffects,
            at,
          }),
          status: 'done',
        }));
        if (updated !== undefined) {
          await log(deps, updated, deps.texts.approveLog(updated.title));
          await replier.reply(message.conversation, { text: deps.texts.approved(updated) });
        }
        return 'handled';
      }

      const updated = await deps.repo.update(id, (current) => ({
        ...current,
        status: 'closed',
        closedReason: 'declined',
      }));
      if (updated !== undefined) {
        await log(deps, updated, deps.texts.declineLog(updated.title));
        await replier.reply(message.conversation, { text: deps.texts.declined(updated.title) });
      }
      return 'handled';
    },
  };
}
