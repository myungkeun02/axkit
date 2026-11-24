/** Short chat replies that call off what the assistant is waiting to do ("취소해", "하지 마", "cancel"). */
const CANCEL =
  /^(?:(?:그거\s*|그건\s*|이거\s*|방금\s*(?:거\s*)?)?(?:취소|취소해|취소해\s*줘|취소할게|취소요|그만|그만해|그만해\s*줘|하지\s*마|하지\s*마세요|하지\s*말아\s*줘|안\s*해도\s*돼|됐어|됐어요|보내지\s*마|멈춰)|cancel|cancel\s+it|stop|don'?t|never\s*mind|nevermind)$/i;

/** True when the whole message is a cancellation, not a question or a new request. */
export function isCancelPhrase(text: string): boolean {
  const clean = text.trim().replace(/[.!?~…。,\s]+$/u, '').replace(/^[.!?~…。,\s]+/u, '');
  if (clean.length === 0 || clean.length > 20) return false;
  return CANCEL.test(clean);
}
