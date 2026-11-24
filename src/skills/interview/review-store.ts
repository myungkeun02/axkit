import { z } from 'zod';
import type { ReviewItem } from '../../core/contracts/review.js';
import type { KeyValueStore } from '../../core/store/types.js';

const ItemSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
});

const ReviewSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  items: z.array(ItemSchema),
  startedAt: z.string(),
  fixing: z.boolean().default(false),
  fixingAt: z.string().optional(),
});

export type PendingReview = z.infer<typeof ReviewSchema>;

export interface ReviewStartInput {
  id: string;
  title: string;
  items: readonly ReviewItem[];
  startedAt: string;
}

const KEY = 'reviews';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function fresh(review: PendingReview, now: Date): boolean {
  const started = Date.parse(review.startedAt);
  return Number.isFinite(started) && now.getTime() - started <= MAX_AGE_MS;
}

/** Pending review cards, kept in the plugin's key-value store. A card older than a week is ignored. */
export class ReviewStore {
  private reviews: PendingReview[] = [];

  constructor(private readonly kv: KeyValueStore) {}

  async load(now: Date): Promise<void> {
    const raw = await this.kv.get<unknown>(KEY);
    const parsed = Array.isArray(raw) ? raw.flatMap(readReview) : [];
    const kept = parsed.filter((review) => fresh(review, now));
    this.reviews = kept;
    if (kept.length !== parsed.length) await this.save();
  }

  get all(): readonly PendingReview[] {
    return this.reviews;
  }

  find(id: string, now: Date): PendingReview | undefined {
    const review = this.reviews.find((candidate) => candidate.id === id);
    return review !== undefined && fresh(review, now) ? review : undefined;
  }

  newest(now: Date): PendingReview | undefined {
    return [...this.reviews]
      .filter((review) => fresh(review, now))
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
  }

  /** A new request with the same id replaces the old one. */
  async start(input: ReviewStartInput): Promise<PendingReview> {
    this.reviews = this.reviews.filter((review) => review.id !== input.id);
    const review: PendingReview = {
      id: input.id,
      title: input.title,
      items: input.items.map((item) => ({ id: item.id, text: item.text })),
      startedAt: input.startedAt,
      fixing: false,
    };
    this.reviews.push(review);
    await this.save();
    return review;
  }

  async setFixing(id: string, fixing: boolean, at?: string): Promise<PendingReview | undefined> {
    const review = this.reviews.find((candidate) => candidate.id === id);
    if (review === undefined) return undefined;
    review.fixing = fixing;
    if (fixing && at !== undefined) review.fixingAt = at;
    await this.save();
    return review;
  }

  async drop(id: string): Promise<void> {
    this.reviews = this.reviews.filter((review) => review.id !== id);
    await this.save();
  }

  async save(): Promise<void> {
    await this.kv.set(KEY, this.reviews);
  }
}

function readReview(value: unknown): PendingReview[] {
  const parsed = ReviewSchema.safeParse(value);
  return parsed.success ? [parsed.data] : [];
}
