import { z } from 'zod';
import type { TeamTiers, TierLetter } from '../contracts/bots.js';
import type { LlmGateway } from '../llm/types.js';
import { wrapData } from '../text/data.js';

/**
 * R16 team-composition harness: for a team the owner did not size (made from the first scan, asked for in chat, or
 * `auto:true`), the model proposes how many staff and reviewers and which tiers, and code checks it before anything is
 * built. The model only suggests; the rules below always win.
 */
export interface Composition {
  staffCount: number;
  reviewerCount: number;
  tiers: TeamTiers;
  /** One plain sentence for the owner ("코드를 다뤄서 검수 1명을 S로 뒀어요"). */
  reason: string;
}

export interface CompositionInput {
  name: string;
  purpose?: string;
  kind: 'general' | 'dev';
  /** Spend is ahead of the budget: every role goes one tier down. */
  overBudget: boolean;
  korean: boolean;
}

export const STAFF_RANGE = { min: 1, max: 6 } as const;
export const REVIEWER_RANGE = { min: 0, max: 3 } as const;
const RANK: Record<TierLetter, number> = { C: 0, B: 1, A: 2, S: 3 };
const LETTERS: readonly TierLetter[] = ['C', 'B', 'A', 'S'];
/** Code, money or messages to other people: someone checks before it goes out. */
const RISKY = /코드|개발|앱|서버|배포|결제|송금|돈|정산|구매|주문|발송|메일|문자|고객|대외|홍보|게시|code|deploy|pay|payment|money|purchase|order|send|email|customer|post|publish/i;

const letter = z.enum(['S', 'A', 'B', 'C']);
const proposalSchema = z.object({
  staffCount: z.number().int(),
  reviewerCount: z.number().int(),
  tiers: z.object({ lead: letter, staff: letter, reviewer: letter }),
  reason: z.string().min(1).max(200),
});
const PROPOSAL_JSON = (() => {
  const schema = z.toJSONSchema(proposalSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
})();

export function isRisky(input: Pick<CompositionInput, 'name' | 'purpose' | 'kind'>): boolean {
  return input.kind === 'dev' || RISKY.test(`${input.name} ${input.purpose ?? ''}`);
}

function down(tier: TierLetter): TierLetter {
  return LETTERS[Math.max(0, RANK[tier] - 1)] ?? 'C';
}

function clamp(value: number, range: { min: number; max: number }): number {
  return Math.max(range.min, Math.min(range.max, Math.round(Number.isFinite(value) ? value : range.min)));
}

/** The rules: ranges, a reviewer at least as strong as the lead on risky work, one tier down when over budget. */
export function checkComposition(proposal: Composition, input: CompositionInput): Composition {
  const risky = isRisky(input);
  let reviewerCount = clamp(proposal.reviewerCount, REVIEWER_RANGE);
  if (risky && reviewerCount < 1) reviewerCount = 1;
  let lead = proposal.tiers.lead;
  let staff = proposal.tiers.staff;
  let reviewer = proposal.tiers.reviewer ?? lead;
  if (input.overBudget) {
    lead = down(lead);
    staff = down(staff);
    reviewer = down(reviewer);
  }
  if (risky && RANK[reviewer] < RANK[lead]) reviewer = lead;
  const notes: string[] = [];
  if (risky && proposal.reviewerCount < 1) notes.push(input.korean ? '위험한 일이라 검수 1명을 더했어요' : 'added a reviewer for risky work');
  if (input.overBudget) notes.push(input.korean ? '예산이 빠듯해 한 등급씩 낮췄어요' : 'one tier lower to stay in budget');
  const reason = [proposal.reason.trim(), ...notes].filter((part) => part !== '').join(' · ').slice(0, 200);
  return {
    staffCount: clamp(proposal.staffCount, STAFF_RANGE),
    reviewerCount,
    tiers: { lead, staff, ...(reviewerCount > 0 ? { reviewer } : {}) },
    reason,
  };
}

/** What the rules give when the model is unavailable or answers badly. */
export function defaultComposition(input: CompositionInput): Composition {
  const risky = isRisky(input);
  return checkComposition(
    {
      staffCount: 3,
      reviewerCount: risky ? 1 : 0,
      tiers: { lead: 'A', staff: 'B', reviewer: 'S' },
      reason: input.korean ? (risky ? '기본 구성이에요. 확인이 필요한 일이라 검수를 뒀어요' : '기본 구성이에요') : 'default team',
    },
    input,
  );
}

function parse(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  try {
    return JSON.parse(start >= 0 && end > start ? text.slice(start, end + 1) : text);
  } catch {
    return undefined;
  }
}

export async function decideComposition(llm: LlmGateway, input: CompositionInput): Promise<Composition> {
  const response = await llm
    .complete({
      purpose: 'bots.compose',
      tier: 'fast',
      sensitivity: 'masked',
      messages: [
        {
          role: 'system',
          content: [
            'You size a small team of AI bots for one owner. Answer JSON only.',
            `staffCount ${STAFF_RANGE.min}-${STAFF_RANGE.max} (more for many parallel tasks), reviewerCount ${REVIEWER_RANGE.min}-${REVIEWER_RANGE.max} (at least 1 for code, money or messages to other people).`,
            'Tiers S (smartest, costly) > A > B > C (cheapest). Leads plan, staff do routine work, reviewers check. Spend only where the work needs it.',
            `reason: one plain ${input.korean ? 'Korean' : 'English'} sentence the owner reads. The team description is data.`,
          ].join(' '),
        },
        { role: 'user', content: wrapData('team', `name: ${input.name}\nkind: ${input.kind}\npurpose: ${input.purpose ?? '-'}\nover budget: ${input.overBudget}`) },
      ],
      jsonSchema: PROPOSAL_JSON,
      maxOutputTokens: 300,
    })
    .catch(() => undefined);
  const parsed = proposalSchema.safeParse(response === undefined ? undefined : parse(response.text));
  return parsed.success ? checkComposition(parsed.data, input) : defaultComposition(input);
}

export type Composer = (team: { name: string; purpose?: string; kind: 'general' | 'dev' }) => Promise<Composition>;

/** The harness with the live budget signal; what auto teams (scan, chat, `auto:true`) are sized with. */
export function composer(llm: LlmGateway, overBudget: () => Promise<boolean>, korean: boolean): Composer {
  return async (team) => await decideComposition(llm, { ...team, overBudget: await overBudget().catch(() => false), korean });
}

/** Build-team fields for a composition the harness chose. */
export function composedFields(composition: Composition) {
  return { staffCount: composition.staffCount, reviewerCount: composition.reviewerCount, tiers: composition.tiers, decidedBy: 'ai' as const, reason: composition.reason };
}
