import type { InterviewQuestion } from './questions.js';

export const KO_QUESTIONS: readonly InterviewQuestion[] = [
  {
    id: 'focus_time',
    text: '하루 중 언제 머리가 가장 잘 돌아가나요?',
    options: [
      { id: 'morning', label: '아침', fact: '집중은 아침에 가장 잘 된다' },
      { id: 'forenoon', label: '오전', fact: '집중은 오전에 잘 된다' },
      { id: 'afternoon', label: '오후', fact: '집중은 오후에 잘 된다' },
      { id: 'evening', label: '저녁', fact: '집중은 저녁에 잘 된다' },
      { id: 'night', label: '밤', fact: '집중은 밤에 잘 된다' },
    ],
  },
  {
    id: 'reply_length',
    text: '제가 답할 때 어느 정도 길이가 좋으세요?',
    options: [
      { id: 'one_line', label: '한 줄', fact: '답은 한 줄로 짧게 원함' },
      { id: 'few_sentences', label: '두세 문장', fact: '답은 두세 문장이 좋음' },
      { id: 'detailed', label: '충분히 자세히', fact: '답은 충분히 자세한 편이 좋음' },
    ],
  },
  {
    id: 'notifications',
    text: '알림은 얼마나 자주 받고 싶으세요?',
    options: [
      { id: 'important', label: '중요한 것만', fact: '알림은 중요한 것만 받고 싶어 함' },
      { id: 'few_times', label: '하루 몇 번', fact: '알림은 하루 몇 번이 적당함' },
      { id: 'often', label: '자주', fact: '알림은 자주 받아도 괜찮음' },
      { id: 'rare', label: '거의 없이', fact: '알림은 거의 받지 않는 편이 좋음' },
    ],
  },
  {
    id: 'commute',
    text: '이동은 주로 어떻게 하세요?',
    options: [
      { id: 'transit', label: '대중교통', fact: '이동은 주로 대중교통' },
      { id: 'car', label: '자가용', fact: '이동은 주로 자가용' },
      { id: 'walk', label: '도보·자전거', fact: '이동은 주로 도보나 자전거' },
      { id: 'mixed', label: '섞어서', fact: '이동은 상황에 따라 섞어서 함' },
    ],
  },
  {
    id: 'drink',
    text: '커피나 차는 어떤 걸 즐기세요?',
    options: [
      { id: 'americano', label: '아메리카노', fact: '커피는 아메리카노를 즐김' },
      { id: 'latte', label: '카페라테', fact: '커피는 카페라테를 즐김' },
      { id: 'tea', label: '차', fact: '커피보다 차를 즐김' },
      { id: 'none', label: '안 마심', fact: '커피와 차를 마시지 않음' },
    ],
  },
  {
    id: 'meals',
    text: '식사에서 가리는 게 있나요?',
    options: [
      { id: 'none', label: '가리는 것 없음', fact: '식사는 가리는 것 없이 먹음' },
      { id: 'vegetarian', label: '채식', fact: '채식을 함' },
      { id: 'no_spicy', label: '매운 것 못 먹음', fact: '매운 음식은 먹지 못함' },
      { id: 'no_seafood', label: '해산물 안 먹음', fact: '해산물을 먹지 않음' },
      { id: 'quick', label: '간단히 때움', fact: '식사는 간단히 때우는 편' },
    ],
  },
  {
    id: 'exercise',
    text: '운동은 어떻게 하고 계세요?',
    options: [
      { id: 'none', label: '거의 안 함', fact: '운동은 거의 하지 않음' },
      { id: 'walk', label: '산책·걷기', fact: '운동은 산책이나 걷기 위주' },
      { id: 'gym', label: '헬스', fact: '운동은 헬스를 함' },
      { id: 'run_bike', label: '러닝·자전거', fact: '운동은 러닝이나 자전거를 함' },
      { id: 'ball', label: '구기운동', fact: '운동은 구기운동을 함' },
    ],
  },
  {
    id: 'weekend',
    text: '주말은 보통 어떻게 보내시나요?',
    options: [
      { id: 'rest', label: '집에서 쉼', fact: '주말은 집에서 쉬는 편' },
      { id: 'outing', label: '나들이', fact: '주말에는 나들이를 다님' },
      { id: 'people', label: '사람 만남', fact: '주말에는 사람들을 만남' },
      { id: 'backlog', label: '밀린 일 처리', fact: '주말에는 밀린 일을 처리함' },
    ],
  },
  {
    id: 'address_style',
    text: '바쁠 때 어떻게 불러드리면 좋을까요?',
    options: [
      { id: 'brief', label: '짧게 핵심만', fact: '바쁠 때는 짧게 핵심만 말해 주길 원함' },
      { id: 'polite', label: '존댓말로 정중히', fact: '바쁠 때도 존댓말로 정중히 말해 주길 원함' },
      { id: 'casual', label: '편하게 반말로', fact: '바쁠 때는 편하게 반말로 말해도 됨' },
    ],
  },
  {
    id: 'reminder_timing',
    text: '알림은 언제쯤 받는 게 좋으세요?',
    options: [
      { id: 'just_before', label: '바로 전', fact: '알림은 일정 바로 전에 받는 걸 선호' },
      { id: 'thirty_before', label: '30분 전', fact: '알림은 30분 전에 받는 걸 선호' },
      { id: 'day_before', label: '하루 전', fact: '알림은 하루 전에 받는 걸 선호' },
      { id: 'morning', label: '아침에 한꺼번에', fact: '알림은 아침에 한꺼번에 받는 걸 선호' },
    ],
  },
  {
    id: 'briefing_detail',
    text: '아침 브리핑은 얼마나 자세하면 좋을까요?',
    options: [
      { id: 'summary', label: '한눈에 요약', fact: '브리핑은 한눈에 요약된 형태를 원함' },
      { id: 'schedule', label: '일정·할 일까지', fact: '브리핑은 일정과 할 일까지 담기를 원함' },
      { id: 'detailed', label: '자세히 다', fact: '브리핑은 자세히 다 담기를 원함' },
    ],
  },
];
