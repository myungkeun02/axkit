import type { RestaurantInput, SeatTrain, SeatWatch, ShopInput, TrainInput } from './types.js';

/** Owner-facing words for errands, in Korean 해요체. Page-derived values are quoted as they came. */

const OPERATOR = { ktx: '코레일(KTX)', srt: 'SRT' } as const;
const SEAT = { standard: '일반실', first: '특실', any: '좌석 등급 상관없음' } as const;

function people(train: SeatTrain | TrainInput): string {
  const parts = [`어른 ${train.adults}`];
  if (train.children > 0) parts.push(`어린이 ${train.children}`);
  if (train.seniors > 0) parts.push(`경로 ${train.seniors}`);
  return parts.join('·');
}

export function trainLine(train: SeatTrain | TrainInput): string {
  const window = train.latest !== undefined ? `${train.time}~${train.latest}` : `${train.time} 이후`;
  return `${OPERATOR[train.operator]} ${train.from} → ${train.to}, ${train.date} ${window}, ${people(train)}, ${SEAT[train.seatClass]}`;
}

function detailLines(details: Record<string, string>, keys: readonly [string, string][]): string[] {
  return keys.flatMap(([key, label]) => (details[key] !== undefined ? [`· ${label}: ${details[key]}`] : []));
}

const TRAIN_KEYS: [string, string][] = [['TRAIN', '열차'], ['DEPART', '출발'], ['ARRIVE', '도착'], ['SEAT', '좌석'], ['PRICE', '요금'], ['DEADLINE', '결제 기한']];
const RESTAURANT_KEYS: [string, string][] = [['PLACE', '식당'], ['DATE', '날짜'], ['TIME', '시간'], ['PARTY', '인원'], ['OPTION', '좌석·옵션'], ['DEPOSIT', '예약금'], ['CANCEL', '취소 규정']];
const SHOP_KEYS: [string, string][] = [['ITEM', '상품'], ['OPTIONS', '옵션'], ['QUANTITY', '수량'], ['PRICE', '상품 금액'], ['DELIVERY', '배송'], ['TOTAL', '합계'], ['SELLER', '판매자']];

export const errandTexts = {
  cardNote: '예약·구매로 이어질 수 있는 심부름이라 매번 여쭤봐요. 결제와 마지막 확정 버튼은 비서가 누르지 않아요.',

  trainCard(input: TrainInput): string {
    const lines = [`기차표 찾기: ${trainLine(input)}`];
    if (input.preference !== undefined) lines.push(`고르는 기준: ${input.preference}`);
    if (input.approvedButton !== undefined) {
      lines.push(`이번에는 '${input.approvedButton}' 버튼만 눌러 좌석을 잡고 결제 화면에서 멈춰요. 결제는 직접 하셔야 해요.`);
    } else {
      lines.push('열차를 비교해 골라 예매 버튼 바로 앞에서 멈춰요. 로그인·결제는 직접 하셔야 해요.');
    }
    return lines.join('\n');
  },

  restaurantCard(input: RestaurantInput): string {
    const flex = input.flexMinutes > 0 ? ` (앞뒤 ${input.flexMinutes}분까지 괜찮음)` : '';
    const lines = [`식당 예약 준비: ${input.place}, ${input.date} ${input.time}${flex}, ${input.partySize}명`];
    if (input.preference !== undefined) lines.push(`원하시는 것: ${input.preference}`);
    lines.push('날짜·시간·인원까지 채우고 [예약하기] 바로 앞에서 멈춰요. 예약금이 있거나 취소 규정이 분명하지 않으면 먼저 여쭤봐요.');
    return lines.join('\n');
  },

  shopCard(input: ShopInput): string {
    const where = input.url ?? input.site ?? input.continueUrl ?? '';
    const lines = [`장바구니 담기: ${input.product} ${input.quantity}개${input.options.length > 0 ? ` (${input.options.join(', ')})` : ''}`];
    if (where !== '') lines.push(`어디서: ${where}`);
    if (input.maxPrice !== undefined) lines.push(`${input.maxPrice.toLocaleString('ko-KR')}원이 넘으면 담지 않아요.`);
    lines.push('장바구니에 담는 데까지만 하고 주문·결제는 직접 하시도록 넘겨 드려요.');
    return lines.join('\n');
  },

  trainReady(details: Record<string, string>, button: string | undefined): string {
    return ['예매 바로 앞까지 준비했어요.', ...detailLines(details, TRAIN_KEYS), `여기서 '${button ?? '예매'}'를 눌러 주세요.`,
      "비서가 눌러도 되면 '눌러도 돼'라고 해 주세요 — 좌석만 잡고 결제 화면에서 멈춰요."].join('\n');
  },
  trainHeld(details: Record<string, string>): string {
    return ['좌석을 잡고 결제 화면에서 멈췄어요.', ...detailLines(details, TRAIN_KEYS),
      '여기서 결제하기를 눌러 직접 결제해 주세요. 결제 기한이 짧으니 서둘러 주세요.'].join('\n');
  },
  trainNone: (details: Record<string, string>) =>
    ['조건에 맞는 빈자리가 없어요.', ...detailLines(details, TRAIN_KEYS),
      "원하시면 '빈자리 나면 알려 줘'라고 해 주세요 — 10~15분에 한 번만 조회하고, 자리가 나면 알려 드려요(예매는 하지 않아요)."].join('\n'),

  restaurantReady(details: Record<string, string>, button: string | undefined): string {
    return ['예약 직전까지 준비했어요.', ...detailLines(details, RESTAURANT_KEYS), `여기서 '${button ?? '예약하기'}'를 눌러 주세요.`].join('\n');
  },
  restaurantDeposit(details: Record<string, string>): string {
    return ['예약금(선결제)이 있어서 멈췄어요. 금액과 환불 조건을 보시고 정해 주세요.', ...detailLines(details, RESTAURANT_KEYS),
      '진행하시려면 직접 예약하고 결제해 주세요. 비서는 예약금을 내지 않아요.'].join('\n');
  },
  restaurantCancelUnclear(details: Record<string, string>): string {
    return ['취소 규정이 분명하지 않아서 멈췄어요. 페이지에서 취소·환불 조건을 확인해 주세요.', ...detailLines(details, RESTAURANT_KEYS),
      '괜찮으시면 직접 예약하기를 눌러 주세요.'].join('\n');
  },
  restaurantNone: (details: Record<string, string>) =>
    ['그 시간에는 자리가 없어요.', ...detailLines(details, RESTAURANT_KEYS),
      ...(details['OTHER_TIMES'] !== undefined ? [`· 가능한 다른 시간: ${details['OTHER_TIMES']}`] : [])].join('\n'),

  shopReady: (details: Record<string, string>) =>
    ['장바구니에 담았어요.', ...detailLines(details, SHOP_KEYS), '여기서 주문·결제는 직접 해 주세요. 비서는 결제하지 않아요.'].join('\n'),
  shopNotAdded: (details: Record<string, string>) =>
    ['장바구니에 담지 않았어요(조건에 맞지 않거나 상품을 못 찾았어요).', ...detailLines(details, SHOP_KEYS)].join('\n'),
  shopChoice: '고르셔야 할 옵션이 있어서 멈췄어요. 원하시는 옵션을 알려 주시거나 직접 골라 주세요.',

  needsHuman: '직접 하셔야 하는 화면에서 멈췄어요. 마치시면 같은 심부름을 이어서 할게요.',
  blocked: '이 사이트가 자동으로 움직이는 브라우저의 접속을 막았어요(Access Denied). 비서는 이런 차단을 피해 가지 않아요. 직접 하시려면 "화면에 열어 줘"라고 해 주세요 — 이 맥 화면에 같은 페이지를 열어 드릴게요.',
  committed: '확정·결제가 끝난 것처럼 보이는 화면이 있었어요. 비서는 누르지 않았지만, 예약·주문 내역을 바로 확인해 주세요.',
  failed: '심부름을 끝내지 못했어요. 잠시 뒤에 다시 해 보거나 직접 확인해 주세요.',

  watchCard(train: SeatTrain, everyMinutes: number, hours: number): string {
    return [`빈자리 감시: ${trainLine(train)}`, `${everyMinutes}분에 한 번만 조회하고 ${hours}시간 뒤에 저절로 끝나요.`,
      '자리가 나면 알려 드리기만 하고, 예매는 직접 하라고 하실 때만 결제 직전까지 해요.'].join('\n');
  },
  watchCardNote: '예매 사이트를 주기적으로 조회해요. 잦은 조회는 매크로로 보일 수 있어 10분보다 자주 하지 않아요.',
  watchAdded: (watch: SeatWatch, endsLocal: string) => `빈자리 감시를 시작했어요. ${watch.everyMinutes}분마다 조회하고 ${endsLocal}에 끝나요.`,
  watchFull: '빈자리 감시는 한 번에 2개까지만 해요. 하나를 끝낸 뒤 다시 말해 주세요.',
  watchFound: (watch: SeatWatch, details: Record<string, string>) =>
    [`🔔 빈자리가 났어요: ${trainLine(watch.train)}`, ...detailLines(details, TRAIN_KEYS),
      "예매하시려면 '그 기차 예매 진행해 줘'라고 해 주세요 — 결제 직전까지 하고 결제는 넘겨 드려요. 감시는 여기서 끝냈어요."].join('\n'),
  watchEnded: (watch: SeatWatch) => `빈자리 감시가 끝났어요(${trainLine(watch.train)}). 그동안 자리가 나지 않았어요.`,
  watchBlocked: (watch: SeatWatch) =>
    `예매 사이트가 로그인이나 로봇 확인을 요구해서 빈자리 감시를 멈췄어요(${trainLine(watch.train)}). 확인 창은 비서가 풀지 않아요.`,
  watchFailing: (watch: SeatWatch) => `빈자리 조회가 계속 안 돼서 감시를 멈췄어요(${trainLine(watch.train)}).`,
  watchStopped: (watch: SeatWatch) => `빈자리 감시를 멈췄어요: ${trainLine(watch.train)}`,
  watchNone: '진행 중인 빈자리 감시가 없어요.',
  stopDescribe: (id: string) => `빈자리 감시 끝내기: ${id}`,
};

export type ErrandTexts = typeof errandTexts;
