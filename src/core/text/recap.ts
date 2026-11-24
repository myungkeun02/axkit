/**
 * One shape for every place work passes from one agent to another or back to the owner: a browser run that stops at a
 * login, a dev-assist job between rounds, a company-mode handoff, a summary before the context is compacted.
 * Rules: completed work only under `done`; "not verified" caveats are cut last when the size is capped; a next action is
 * never invented (null when there is none). Ported from AX `handoff/recap.ts`.
 */
export interface Recap {
  /** Completed outcomes only, not what was looked at. */
  done: string[];
  /** Choices already made (owner answers, verdicts) the next step must not reopen. */
  decisions: string[];
  /** Limits and owner preferences that still apply. */
  constraints: string[];
  /** What is still open, concretely. */
  remaining: string[];
  /** Not verified, not confirmed on the page, checks skipped. */
  unverified: string[];
  nextAction: string | null;
}

export const RECAP_MAX_BYTES = 3000;
const ITEM_MAX = 300;
const ITEMS_MAX = 8;
/** Over the cap, the least important list loses its last item first; `unverified` goes last. */
const CUT_ORDER = ['done', 'decisions', 'constraints', 'remaining', 'unverified'] as const;
const LISTS = ['done', 'decisions', 'constraints', 'remaining', 'unverified'] as const;

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > ITEM_MAX ? `${flat.slice(0, ITEM_MAX - 1)}…` : flat;
}

function list(items: readonly string[] | undefined): string[] {
  return [...new Set((items ?? []).map(clip).filter((item) => item !== ''))].slice(0, ITEMS_MAX);
}

function size(recap: Recap): number {
  return new TextEncoder().encode(JSON.stringify(recap)).length;
}

/** Clips items, drops empties and duplicates, then trims lists until the JSON fits in `maxBytes`. */
export function capRecap(input: Partial<Recap>, maxBytes = RECAP_MAX_BYTES): Recap {
  const out: Recap = {
    done: list(input.done),
    decisions: list(input.decisions),
    constraints: list(input.constraints),
    remaining: list(input.remaining),
    unverified: list(input.unverified),
    nextAction: input.nextAction !== undefined && input.nextAction !== null && input.nextAction.trim() !== '' ? clip(input.nextAction) : null,
  };
  for (const key of CUT_ORDER) {
    while (size(out) > maxBytes && out[key].length > 0) out[key].pop();
  }
  return out;
}

const LABELS = {
  ko: { done: '한 일', decisions: '정해진 것', constraints: '지킬 것', remaining: '남은 일', unverified: '확인 안 됨', nextAction: '다음 행동', none: '없음' },
  en: { done: 'Done', decisions: 'Decisions', constraints: 'Constraints', remaining: 'Remaining', unverified: 'Not verified', nextAction: 'Next action', none: 'none' },
} as const;

/** Plain lines in the standard order; empty lists are left out. */
export function renderRecap(recap: Recap, language: 'ko' | 'en' = 'ko'): string {
  const labels = LABELS[language];
  const lines: string[] = [];
  for (const key of LISTS) {
    if (recap[key].length > 0) lines.push(`${labels[key]}: ${recap[key].join(' / ')}`);
  }
  lines.push(`${labels.nextAction}: ${recap.nextAction ?? labels.none}`);
  return lines.join('\n');
}
