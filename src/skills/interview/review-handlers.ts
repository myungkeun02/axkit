import { Contracts } from '../../core/contracts/index.js';
import type { ReviewAnswer } from '../../core/contracts/review.js';
import type { MessageHandler } from '../../core/conversation/types.js';
import { notifyReview } from './review.js';
import type { ReviewDeps } from './review.js';
import type { PendingReview } from './review-store.js';

const PRIORITY = 82;
const CHOICE = /^\(choice:\s*review:([A-Za-z0-9_.-]+):(ok|fix)\)$/u;
const SHOW_AGAIN: readonly RegExp[] = [
  /^확인\s*카드\s*다시(?:\s*보여\s*줘)?[\s!?.~]*$/u,
  /^show\s+(?:me\s+)?the\s+review(?:\s+again)?[\s!?.]*$/i,
];
const DONE = /^(?:끝|됐어|done)[\s!?.~]*$/iu;
const WITH_MARK = /^(\d{1,2})\s*번\s*[.:)-]?\s*(.+)$/u;
const PLAIN = /^(\d{1,2})\s*[.:)-]?\s+(.+)$/u;
const REMOVED = /^(삭제|지워|지워줘|틀림|틀렸어|아님|아니야|없음|remove|delete|wrong)[.!]?$/iu;
const MAX_CORRECTION_CHARS = 300;

const FIXING_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Fixing mode ends on its own, so a forgotten "끝" does not swallow numbered chat for a week. */
function fixingNow(review: PendingReview, now: Date): boolean {
  if (!review.fixing) return false;
  const since = review.fixingAt === undefined ? Number.NaN : Date.parse(review.fixingAt);
  return Number.isFinite(since) && now.getTime() - since <= FIXING_WINDOW_MS;
}

interface ParsedLine {
  number: number;
  body: string;
  marked: boolean;
}

function parseCorrectionSet(text: string): ParsedLine[] | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return undefined;

  const parsed: ParsedLine[] = [];
  for (const line of lines) {
    const marked = WITH_MARK.exec(line);
    if (marked !== null && marked[1] !== undefined && marked[2] !== undefined) {
      parsed.push({ number: Number(marked[1]), body: marked[2].trim(), marked: true });
      continue;
    }
    const plain = PLAIN.exec(line);
    if (plain !== null && plain[1] !== undefined && plain[2] !== undefined) {
      parsed.push({ number: Number(plain[1]), body: plain[2].trim(), marked: false });
      continue;
    }
    return undefined;
  }
  return parsed;
}

async function rememberCorrection(deps: ReviewDeps, review: PendingReview, itemId: string, text: string): Promise<void> {
  const memory = deps.ctx.tryUse(Contracts.memoryWrite);
  if (memory === undefined) return;
  try {
    await memory.remember({
      subject: 'owner',
      text,
      source: { kind: 'interview', ref: `review:${review.id}:${itemId}` },
      halfLifeDays: 365,
    });
  } catch (error) {
    deps.ctx.log.warn('interview: the review correction could not be remembered', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function summaryOf(deps: ReviewDeps, corrected: readonly number[], removed: readonly number[]): string {
  const parts: string[] = [];
  if (corrected.length > 0) parts.push(deps.texts.corrected(corrected));
  if (removed.length > 0) parts.push(deps.texts.removed(removed));
  return parts.join(' ');
}

async function applyCorrections(deps: ReviewDeps, review: PendingReview, parsed: readonly ParsedLine[]): Promise<'range' | 'applied'> {
  for (const line of parsed) {
    if (line.number < 1 || line.number > review.items.length) return 'range';
  }

  const corrected: number[] = [];
  const removed: number[] = [];
  for (const line of parsed) {
    const item = review.items[line.number - 1];
    if (item === undefined) continue;
    const verdict: ReviewAnswer['verdict'] = REMOVED.test(line.body) ? 'removed' : 'corrected';
    if (verdict === 'corrected') {
      const text = line.body.trim().slice(0, MAX_CORRECTION_CHARS);
      corrected.push(line.number);
      await deps.ctx.bus.emit('review.answer', { reviewId: review.id, itemId: item.id, verdict, text });
      await rememberCorrection(deps, review, item.id, text);
    } else {
      removed.push(line.number);
      await deps.ctx.bus.emit('review.answer', { reviewId: review.id, itemId: item.id, verdict });
    }
  }

  return 'applied';
}

/** Owner-only review controls: card buttons, numbered corrections, "done" and "show the card again". */
export function ownerReviewHandler(deps: ReviewDeps): MessageHandler {
  return {
    id: 'interview.review',
    priority: PRIORITY,
    async handle(message, replier) {
      if (!message.fromOwner) return 'pass';
      const trimmed = message.text.trim();
      if (trimmed === '') return 'pass';
      const now = deps.ctx.clock.now();

      const choice = CHOICE.exec(trimmed);
      if (choice !== null && choice[1] !== undefined && choice[2] !== undefined) {
        const review = deps.store.find(choice[1], now);
        if (review === undefined) return 'pass';
        if (choice[2] === 'ok') {
          for (const item of review.items) {
            await deps.ctx.bus.emit('review.answer', {
              reviewId: review.id,
              itemId: item.id,
              verdict: 'confirmed',
            });
          }
          await deps.store.drop(review.id);
          await replier.reply(message.conversation, { text: deps.texts.confirmed });
          return 'handled';
        }
        await deps.store.setFixing(review.id, true, now.toISOString());
        await replier.reply(message.conversation, { text: deps.texts.instructions });
        return 'handled';
      }

      if (SHOW_AGAIN.some((pattern) => pattern.test(trimmed))) {
        const review = deps.store.newest(now);
        if (review === undefined) {
          await replier.reply(message.conversation, { text: deps.texts.noCard });
          return 'handled';
        }
        const sent = await notifyReview(
          deps.ctx,
          review,
          deps.texts,
          `review:${review.id}:${review.startedAt}:again:${now.getTime()}`,
        );
        await replier.reply(message.conversation, { text: sent ? deps.texts.cardAgain : deps.texts.noCard });
        return 'handled';
      }

      const review = deps.store.newest(now);
      if (review === undefined) return 'pass';

      if (DONE.test(trimmed)) {
        if (!fixingNow(review, now)) return 'pass';
        await deps.store.drop(review.id);
        await replier.reply(message.conversation, { text: deps.texts.finished });
        return 'handled';
      }

      const parsed = parseCorrectionSet(trimmed);
      if (parsed === undefined) return 'pass';
      // Outside fixing mode only removals ("3 삭제") count: "3번 출구로 와" is ordinary chat, not a correction.
      const allowed = fixingNow(review, now) || parsed.every((line) => REMOVED.test(line.body));
      if (!allowed) return 'pass';

      const result = await applyCorrections(deps, review, parsed);
      if (result === 'range') {
        await replier.reply(message.conversation, { text: deps.texts.range(review.items.length) });
        return 'handled';
      }

      const corrected = parsed.filter((line) => !REMOVED.test(line.body)).map((line) => line.number);
      const removed = parsed.filter((line) => REMOVED.test(line.body)).map((line) => line.number);
      await replier.reply(message.conversation, { text: summaryOf(deps, corrected, removed) });
      return 'handled';
    },
  };
}
