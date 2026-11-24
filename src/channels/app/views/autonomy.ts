import { z } from 'zod';
import type { AppView } from '../../../core/contracts/device-api.js';
import { ViewInputError } from '../../../core/contracts/device-api.js';
import type { AutonomyRules } from '../../../core/policy/autonomy.js';
import type { AutonomyPromotion } from '../../../core/policy/promoter.js';

const idSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * View "autonomy" (R11): what the assistant now does without asking, because the owner ticked "from now on" on a
 * card or said yes when offered after many approvals ("promoted"), and what it always asks about. Revoking a rule
 * brings the card back next time; a paused rule (failed twice, or corrected) can be turned back on.
 */
export function autonomyView(rules: AutonomyRules, language: string, promotion?: AutonomyPromotion): AppView {
  const alwaysAsk =
    language === 'en'
      ? ['Payments and deletions without a limit you set', 'Anything while everything is stopped', 'Guesses (an unclear date or person)']
      : ['정해 둔 범위 밖의 결제·삭제', '전체 정지 중일 때의 모든 외부 행동', '날짜·사람이 확실하지 않은 일'];
  return {
    name: 'autonomy',
    version: 1,
    async read() {
      const list = await rules.list();
      return {
        rules: list.map((rule) => {
          const counts = promotion?.counts(rule);
          return {
            id: rule.id,
            label: rule.label,
            ...(rule.detail !== undefined ? { detail: rule.detail } : {}),
            since: rule.since,
            uses: rule.uses,
            origin: rule.origin,
            ...(rule.paused !== undefined ? { paused: rule.paused } : {}),
            ...(counts !== undefined ? { approvals: counts.approved, denials: counts.denied + counts.edited, corrections: counts.corrected } : {}),
          };
        }),
        alwaysAsk,
      };
    },
    actions: {
      async revoke(body) {
        const parsed = idSchema.safeParse(body);
        if (!parsed.success) throw new ViewInputError('shape');
        return { id: parsed.data.id, revoked: await rules.revoke(parsed.data.id) };
      },
      async resume(body) {
        const parsed = idSchema.safeParse(body);
        if (!parsed.success) throw new ViewInputError('shape');
        return { id: parsed.data.id, resumed: await rules.resume(parsed.data.id) };
      },
    },
  };
}
