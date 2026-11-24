const CARD_KO = /카드\s*$/;
const CARD_EN = /\bcard\b/i;
const MEMBER_COUNT = /\(\s*\d+\s*\)/;
const COMMA_NAMES = /[,，]/;

const APPOINTMENT_KO =
  /오늘|내일|모레|이번\s?주|다음\s?주|[월화수목금토일]요일|\d{1,2}월\s?\d{1,2}일|\d{1,2}일|\d{1,2}시|오전|오후|저녁|점심|아침/;
const APPOINTMENT_EN =
  /\b(?:today|tomorrow|tonight|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/i;

/** A card company's own room, e.g. "현대카드" or "Example Card". */
export function isCardRoom(room: string): boolean {
  return CARD_KO.test(room.trim()) || CARD_EN.test(room);
}

/** Group chats show a member count ("가족 (5)") or list several comma-separated names. */
export function isGroupRoom(room: string): boolean {
  if (MEMBER_COUNT.test(room)) return true;
  const names = room
    .split(COMMA_NAMES)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  return names.length > 3;
}

/** Cheap pre-filter before spending a model call on possible appointments. */
export function looksLikeAppointment(text: string): boolean {
  return APPOINTMENT_KO.test(text) || APPOINTMENT_EN.test(text);
}
