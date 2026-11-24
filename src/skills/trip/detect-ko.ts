/** Korean words that mark a booking confirmation. Kept as printed text, matched without spaces. */
export const KO_BOOKING_WORDS = [
  '예약 확인',
  '예약이 확정',
  '예약번호',
  '탑승권',
  '항공권',
  'e-티켓',
  '승차권',
  '숙소',
  '체크인',
  '렌터카',
] as const;

/** Markers strong enough to survive promotional wording elsewhere in the mail. */
export const KO_STRONG_WORDS = ['예약 확인', '예약이 확정', '예약번호', '탑승권', 'e-티켓', '승차권'] as const;

export const KO_CANCEL_WORDS = ['예약 취소', '예약이 취소', '취소되었', '취소 처리'] as const;

export const KO_PROMO_WORDS = ['광고', '특가'] as const;
