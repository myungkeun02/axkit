/** What the owner did with a card or suggestion the assistant made. */
export interface CardFeedback {
  /** "spend.category", "chat.appointment", "notice". */
  domain: string;
  /** What the card was about: a merchant key, a room title, a notice kind. */
  subject: string;
  verdict: 'accepted' | 'rejected' | 'corrected';
  /** For `corrected`: the value the owner chose (a category id). */
  correction?: string;
  /** A short label for the weekly proposal ("Example Coffee"). Never a message body. */
  label?: string;
  at: Date;
}

/** An approved adjustment. The plugin that owns `domain` applies it; others ignore it. */
export interface TuningChange {
  id: string;
  domain: string;
  subject: string;
  action: 'mute' | 'unmute' | 'set';
  value?: string;
}

declare module '../events/types.js' {
  interface EventMap {
    'feedback.card': CardFeedback;
    'tuning.apply': TuningChange;
  }
}
