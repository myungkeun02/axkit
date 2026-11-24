/** English words that mark a booking confirmation. Matched case-insensitively on word boundaries. */
export const EN_BOOKING_WORDS = [
  'booking confirmation',
  'reservation confirmed',
  'itinerary',
  'e-ticket',
  'boarding pass',
  'check-in',
  'your trip',
  'confirmation number',
] as const;

/** Markers strong enough to survive promotional wording elsewhere in the mail. */
export const EN_STRONG_WORDS = [
  'booking confirmation',
  'reservation confirmed',
  'e-ticket',
  'boarding pass',
  'confirmation number',
] as const;

export const EN_CANCEL_WORDS = ['cancelled', 'canceled', 'cancellation confirmed'] as const;

export const EN_PROMO_WORDS = ['newsletter', 'deal'] as const;
