export interface ReviewItem {
  /** Stable id the answer event carries back. */
  id: string;
  text: string;
}

export interface ReviewRequest {
  /** One review at a time per id; a new request with the same id replaces the old one. */
  id: string;
  title: string;
  items: readonly ReviewItem[];
}

/** Capability "owner.review": shows numbered lines and lets the owner fix the wrong ones in chat. */
export interface OwnerReview {
  start(request: ReviewRequest): Promise<void>;
}

/** What the owner said about one line. A correction is the owner's own words and outranks anything inferred. */
export interface ReviewAnswer {
  reviewId: string;
  itemId: string;
  verdict: 'confirmed' | 'corrected' | 'removed';
  /** The owner's text, for `corrected`. */
  text?: string;
}

declare module '../events/types.js' {
  interface EventMap {
    'review.answer': ReviewAnswer;
  }
}
