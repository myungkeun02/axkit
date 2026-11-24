import { Contracts } from '../../core/contracts/index.js';
import type { OwnerReview, ReviewRequest } from '../../core/contracts/review.js';
import type { Choice } from '../../core/conversation/types.js';
import type { PluginContext } from '../../core/plugin/types.js';
import type { ReviewTexts } from './review-locale.js';
import type { PendingReview, ReviewStore } from './review-store.js';

const MAX_ITEMS = 25;
const MAX_ITEM_CHARS = 160;
const MAX_TEXT_CHARS = 1900;
const MAX_TITLE_CHARS = 300;

export interface ReviewDeps {
  ctx: PluginContext;
  texts: ReviewTexts;
  store: ReviewStore;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

/** The numbered card the owner sees. Long cards are shortened so one message always fits. */
export function reviewCardText(review: PendingReview, texts: ReviewTexts): string {
  const header = clip(review.title, MAX_TITLE_CHARS);
  const shown = review.items
    .slice(0, MAX_ITEMS)
    .map((item, index) => `${index + 1}. ${clip(item.text, MAX_ITEM_CHARS)}`);

  const build = (count: number): string => {
    const lines = shown.slice(0, count).join('\n');
    return lines === '' ? `${header}\n\n${texts.cardHint}` : `${header}\n\n${lines}\n\n${texts.cardHint}`;
  };

  let count = shown.length;
  let text = build(count);
  while (text.length >= MAX_TEXT_CHARS && count > 0) {
    count -= 1;
    text = build(count);
  }
  if (text.length >= MAX_TEXT_CHARS) {
    const room = Math.max(0, MAX_TEXT_CHARS - texts.cardHint.length - 4);
    text = `${clip(header, room)}\n\n${texts.cardHint}`;
  }
  return text;
}

export function reviewChoices(review: PendingReview, texts: ReviewTexts): Choice[] {
  return [
    { id: `review:${review.id}:ok`, label: texts.allCorrect },
    { id: `review:${review.id}:fix`, label: texts.fixLine },
  ];
}

/** Shows the card through the notifier. False when there is nowhere to send it; the review stays pending. */
export async function notifyReview(
  ctx: PluginContext,
  review: PendingReview,
  texts: ReviewTexts,
  dedupeKey: string,
): Promise<boolean> {
  const notifier = ctx.tryUse(Contracts.notifier);
  if (notifier === undefined) {
    ctx.log.warn('interview: no notifier is available; the review card was kept for later');
    return false;
  }
  await notifier.notify({
    kind: 'review.card',
    text: reviewCardText(review, texts),
    choices: reviewChoices(review, texts),
    dedupeKey,
  });
  return true;
}

/** Capability "owner.review": stores the numbered lines, then sends the card. */
export function createOwnerReview(deps: ReviewDeps): OwnerReview {
  return {
    async start(request: ReviewRequest): Promise<void> {
      const startedAt = deps.ctx.clock.now().toISOString();
      const review = await deps.store.start({
        id: request.id,
        title: request.title,
        items: request.items,
        startedAt,
      });
      await notifyReview(deps.ctx, review, deps.texts, `review:${review.id}:${startedAt}`);
    },
  };
}
