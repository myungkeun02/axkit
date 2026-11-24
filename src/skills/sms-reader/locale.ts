import type { SmishingReason } from './smishing.js';
import type { ReservationStatus } from './types.js';

export interface SmsReaderTexts {
  smishingNotice(sender: string | undefined, reasons: readonly SmishingReason[], hosts: readonly string[]): string;
  reservationTitle(org: string | undefined): string;
  reservationQuestion(title: string, status: ReservationStatus): string;
  reservationCancelled(title: string, evidence: string): string;
  billTodo(payee: string | undefined, amount: number | undefined): string;
  billQuestion(todo: string): string;
  parcelQuestion(carrier: string, invoice: string): string;
  fromNote(sender: string | undefined, evidence: string | undefined, place?: string): string;
  readonly yes: { reservation: string; bill: string; parcel: string };
  readonly remember: { reservation: string; bill: string; parcel: string };
  readonly later: string;
  readonly no: string;
  eventAdded(title: string): string;
  todoAdded(text: string): string;
  parcelState(carrier: string, state: string, where: string | undefined): string;
  parcelDelivered(carrier: string): string;
  parcelUnavailable(carrier: string): string;
}

/** 을/를, 이/가 by the last syllable's final consonant; anything that is not Hangul takes 을/이. */
function josa(word: string, withFinal: string, withoutFinal: string): string {
  const code = word.codePointAt(word.length - 1);
  if (code === undefined || code < 0xac00 || code > 0xd7a3) return withFinal;
  return (code - 0xac00) % 28 === 0 ? withoutFinal : withFinal;
}

function won(amount: number): string {
  return `${amount.toLocaleString('ko-KR')}원`;
}

const KO_REASONS: Record<SmishingReason, string> = {
  apk: '앱 설치 파일(.apk)이나 설치 유도',
  lookalike: '은행·택배·기관 주소를 흉내 낸 링크',
  ip_link: '숫자로만 된 주소 링크',
  short_link: '목적지를 숨기는 짧은 링크',
  odd_domain: '흔치 않은 도메인',
  lure: '주소 확인·과태료·미납·환급 같은 급한 유도',
  sender_mismatch: '기관을 사칭하는데 보낸 번호가 개인·해외 번호',
  callback: '결제 승인처럼 보이게 하고 개인 번호로 전화를 유도',
};

const EN_REASONS: Record<SmishingReason, string> = {
  apk: 'an app install file (.apk) or a push to install an app',
  lookalike: 'a link imitating a bank, courier or agency address',
  ip_link: 'a link to a bare IP address',
  short_link: 'a short link that hides where it goes',
  odd_domain: 'an unusual domain',
  lure: 'an urgent lure (address check, fine, unpaid bill, refund)',
  sender_mismatch: 'it claims to be an organization but came from a personal or foreign number',
  callback: 'it looks like a card approval and asks you to call a personal number',
};

const KO_STATUS: Record<ReservationStatus, string> = { confirmed: '', changed: ' (변경)', cancelled: ' (취소)' };

export const KO_TEXTS: SmsReaderTexts = {
  smishingNotice: (sender, reasons, hosts) =>
    [
      `⚠️ 스미싱 의심 문자예요${sender !== undefined ? ` (보낸 곳: ${sender})` : ''}.`,
      `이유: ${reasons.map((reason) => KO_REASONS[reason]).join(', ')}.`,
      ...(hosts.length > 0 ? [`링크 주소: ${hosts.join(', ')} (열지 않았어요)`] : []),
      '링크를 누르거나 앱을 설치하지 마세요. 확인이 필요하면 공식 앱이나 공식 번호로 직접 연락해 주세요. 이 문자로는 일정·할 일을 만들지 않았어요.',
    ].join('\n'),
  reservationTitle: (org) => (org !== undefined ? `${org} 예약` : '문자로 온 예약'),
  reservationQuestion: (title, status) => `'${title}'${KO_STATUS[status]} 일정을 캘린더에 넣을까요?`,
  reservationCancelled: (title, evidence) =>
    `'${title}'${josa(title, '이', '가')} 취소됐다는 문자가 왔어요 ("${evidence}"). 캘린더에 넣어 두셨다면 직접 지워 주세요.`,
  billTodo: (payee, amount) => [payee ?? '청구서', '납부', ...(amount !== undefined ? [won(amount)] : [])].join(' '),
  billQuestion: (todo) => `'${todo}'${josa(todo, '을', '를')} 할 일에 넣을까요? 결제는 하지 않아요.`,
  parcelQuestion: (carrier, invoice) => `${carrier} 택배(${invoice}) 배송을 따라가 볼까요?`,
  fromNote: (sender, evidence, place) =>
    [
      `문자${sender !== undefined ? ` · ${sender}` : ''}`,
      ...(evidence !== undefined ? [`"${evidence}"`] : []),
      ...(place !== undefined ? [`장소: ${place}`] : []),
    ].join(' · '),
  yes: { reservation: '캘린더에 넣기', bill: '할 일에 넣기', parcel: '배송 따라가기' },
  remember: {
    reservation: '앞으로 문자 속 예약은 묻지 않고 캘린더에 넣기',
    bill: '앞으로 문자 속 청구서는 묻지 않고 할 일에 넣기',
    parcel: '앞으로 문자 속 택배는 묻지 않고 따라가기',
  },
  later: '나중에',
  no: '괜찮아요',
  eventAdded: (title) => `'${title}' 일정을 캘린더에 넣었어요.`,
  todoAdded: (text) => `'${text}'${josa(text, '을', '를')} 할 일에 넣었어요.`,
  parcelState: (carrier, state, where) => `${carrier} 택배: ${state}${where !== undefined && where !== '' ? ` (${where})` : ''}`,
  parcelDelivered: (carrier) => `${carrier} 택배가 배송 완료됐어요. 더 따라가지 않을게요.`,
  parcelUnavailable: (carrier) => `${carrier} 택배는 지금 조회할 수 없어요. 택배 조회 설정을 확인해 주세요.`,
};

const EN_STATUS: Record<ReservationStatus, string> = { confirmed: '', changed: ' (changed)', cancelled: ' (cancelled)' };

export const EN_TEXTS: SmsReaderTexts = {
  smishingNotice: (sender, reasons, hosts) =>
    [
      `⚠️ This text looks like smishing${sender !== undefined ? ` (from ${sender})` : ''}.`,
      `Why: ${reasons.map((reason) => EN_REASONS[reason]).join('; ')}.`,
      ...(hosts.length > 0 ? [`Link address: ${hosts.join(', ')} (not opened)`] : []),
      "Don't tap the link or install anything. To check, contact the organization through its official app or number. No event or to-do was made from it.",
    ].join('\n'),
  reservationTitle: (org) => (org !== undefined ? `${org} booking` : 'Booking from a text'),
  reservationQuestion: (title, status) => `Add '${title}'${EN_STATUS[status]} to your calendar?`,
  reservationCancelled: (title, evidence) =>
    `A text says '${title}' was cancelled ("${evidence}"). If it is on your calendar, please remove it yourself.`,
  billTodo: (payee, amount) => ['Pay', payee ?? 'bill', ...(amount !== undefined ? [won(amount)] : [])].join(' '),
  billQuestion: (todo) => `Add '${todo}' to your to-dos? Nothing will be paid.`,
  parcelQuestion: (carrier, invoice) => `Follow the ${carrier} parcel (${invoice})?`,
  fromNote: (sender, evidence, place) =>
    [
      `Text${sender !== undefined ? ` · ${sender}` : ''}`,
      ...(evidence !== undefined ? [`"${evidence}"`] : []),
      ...(place !== undefined ? [`Place: ${place}`] : []),
    ].join(' · '),
  yes: { reservation: 'Add to calendar', bill: 'Add to-do', parcel: 'Follow it' },
  remember: {
    reservation: 'From now on, add bookings from texts without asking',
    bill: 'From now on, add bills from texts as to-dos without asking',
    parcel: 'From now on, follow parcels from texts without asking',
  },
  later: 'Later',
  no: 'No thanks',
  eventAdded: (title) => `Added '${title}' to your calendar.`,
  todoAdded: (text) => `Added '${text}' to your to-dos.`,
  parcelState: (carrier, state, where) => `${carrier} parcel: ${state}${where !== undefined && where !== '' ? ` (${where})` : ''}`,
  parcelDelivered: (carrier) => `The ${carrier} parcel was delivered. I'll stop following it.`,
  parcelUnavailable: (carrier) => `The ${carrier} parcel can't be looked up right now. Please check the parcel lookup setup.`,
};

export function smsReaderTexts(language: string): SmsReaderTexts {
  return language === 'en' ? EN_TEXTS : KO_TEXTS;
}
