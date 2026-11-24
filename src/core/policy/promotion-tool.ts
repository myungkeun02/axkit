import { z } from 'zod';
import type { Tool } from '../tools/types.js';
import type { AutonomyPromotion } from './promoter.js';

const input = z.object({
  tool: z.string().min(1).max(80).describe('Name of the tool whose latest action the owner undid or said was wrong, e.g. "mail.archive".'),
});

interface CorrectOutput {
  status: 'ok' | 'not_found';
  label?: string;
  paused?: boolean;
}

/**
 * The owner undid or complained about something the assistant did: the latest action of that tool counts as
 * corrected (it no longer counts toward running on its own), and a rule promoted from many approvals pauses.
 * It only ever takes autonomy away, so it runs without a card.
 */
export function autonomyCorrectTool(promotion: AutonomyPromotion): Tool<z.infer<typeof input>, CorrectOutput> {
  return {
    name: 'autonomy.correct',
    description:
      'Call when the owner undoes, reverses or complains about an action the assistant took (on its own or after a yes), ' +
      'e.g. "그거 왜 보관했어", "되돌려 줘", "that was wrong". Pass that action\'s tool name. A kind of action the ' +
      'assistant was doing on its own goes back to asking. Does not undo anything by itself.',
    input,
    effects: ['write'],
    async run(value) {
      const result = await promotion.corrected(value.tool);
      return result === undefined ? { status: 'not_found' } : { status: 'ok', label: result.label, paused: result.paused };
    },
  };
}
