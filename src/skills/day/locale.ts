export type DayLanguage = 'ko' | 'en';

export interface DayTexts {
  readonly language: DayLanguage;
  readonly allDay: string;
  readonly locationMark: string;

  readonly prepTitle: string;
  readonly prepLocationCheck: string;
  readonly prepLocationMissing: string;
  prepCommitment(name: string, text: string): string;
  prepRelatedMail(subjects: string): string;

  travelUrgent(title: string, hhmm: string, minutes: number): string;
  readonly travelNote: string;
  travelAhead(title: string, hhmm: string, place: string, minutes: number, leave: string, mode: 'transit' | 'car' | undefined): string;

  readonly closeTitle: string;
  closeEventCount(count: number): string;
  closeCompletedCount(count: number): string;
  readonly openTodosTitle: string;
  readonly noOpenTodos: string;
  readonly markOverdue: string;
  readonly markToday: string;
  readonly markTomorrow: string;
  tomorrowFirst(label: string): string;
  readonly noTomorrowEvent: string;
  stepsLine(steps: number): string;

  repliesTitle(count: number): string;
  replyLine(from: string, subject: string, days: number): string;
  draftChoice(subject: string): string;
  draftChoiceFor(number: number, who: string): string;
  readonly repliesAsk: string;
  readonly noSubject: string;
  readonly mailNotConnected: string;
  readonly draftFailed: string;
  draftReady(body: string): string;
  readonly approvalNote: string;

  voiceSummary(todoCount: number, eventCount: number): string;
  voiceConfirmSummary(title: string, when: string): string;
  readonly voiceConfirmNote: string;

  stepsNudge(steps: number, goal: number): string;
  readonly waterNudge: string;
  medReminder(name: string): string;
  readonly medDoneLabel: string;
  readonly medSnoozeLabel: string;
  readonly medSnoozeAck: string;

  /** Language name the situational judgment writes in. */
  readonly situationLanguage: string;
  /** Formal filler the assistant never says on its own; a judged line matching it is dropped. */
  readonly filler: RegExp;
}

const KO: DayTexts = {
  language: 'ko',
  allDay: '종일',
  locationMark: '@',

  prepTitle: '내일 준비',
  prepLocationCheck: '장소 확인',
  prepLocationMissing: '장소가 안 적혀 있어요',
  prepCommitment: (name, text) => {
    const honorific = name.endsWith('님') ? name : `${name}님`;
    return `${honorific}께 약속: ${text}`;
  },
  prepRelatedMail: (subjects) => `관련 메일: ${subjects}`,

  travelUrgent: (title, hhmm, minutes) => `지금 출발하면 맞춰요: ${title} ${hhmm}, 약 ${minutes}분`,
  travelNote: '이동 시간은 대략적인 추정이에요.',
  travelAhead: (title, hhmm, place, minutes, leave, mode) =>
    `${hhmm} ${title}(${place})까지 지금 위치에서 ${mode === 'transit' ? '대중교통으로 ' : mode === 'car' ? '차로 ' : ''}약 ${String(minutes)}분 걸려요. ${leave}쯤 출발하면 돼요.${mode === undefined ? ' (직선거리로 어림한 시간이에요)' : ''}`,

  closeTitle: '오늘 마감',
  closeEventCount: (count) => `일정 ${count}개`,
  closeCompletedCount: (count) => `할 일 ${count}개 완료`,
  openTodosTitle: '남은 할 일',
  noOpenTodos: '남은 할 일은 없어요.',
  markOverdue: '(지남)',
  markToday: '(오늘)',
  markTomorrow: '(내일)',
  tomorrowFirst: (label) => `내일 첫 일정: ${label}`,
  noTomorrowEvent: '내일은 일정이 없어요.',
  stepsLine: (steps) => `오늘 걸음 ${steps.toLocaleString('ko-KR')}보`,

  repliesTitle: (count) => `답을 기다리는 메일이 ${count}통 있어요.`,
  replyLine: (from, what, days) => `${from}님 — ${what} (${days}일 전)`,
  draftChoice: (subject) => `초안: ${subject}`,
  draftChoiceFor: (number, who) => `${number}번 ${who}님께 답장 쓰기`,
  repliesAsk: '답장할 메일을 고르면 초안을 써서 먼저 보여 드릴게요. 보내기 전에는 꼭 다시 물어봐요. 답이 필요 없으면 그냥 두셔도 돼요.',
  noSubject: '(제목 없음)',
  mailNotConnected: '메일이 연결되지 않았어요. Gmail 연결이 필요해요.',
  draftFailed: '초안을 만들지 못했어요.',
  draftReady: (body) => `이렇게 답장을 써 봤어요. 아직 보내지 않았어요.\n\n${body}`,
  approvalNote: '이대로 보낼지, 고칠 부분이 있는지 말씀해 주세요. 보내기 전에 결재 카드로 한 번 더 물어볼게요.',

  voiceSummary: (todos, events) => `할 일 ${todos}개 추가, 일정 ${events}개 확인 요청`,
  voiceConfirmSummary: (title, when) => `${title} (${when})`,
  voiceConfirmNote: '음성 메모에서 찾은 일정이에요',

  stepsNudge: (steps, goal) =>
    `오늘 ${steps.toLocaleString('ko-KR')}보 걸었어요. 목표 ${goal.toLocaleString('ko-KR')}보까지 조금만 더 걸어 볼까요?`,
  waterNudge: '물 한 잔 마실 시간이에요.',
  medReminder: (name) => `약 먹을 시간이에요: ${name}`,
  medDoneLabel: '먹었어요',
  medSnoozeLabel: '10분 뒤',
  medSnoozeAck: '10분 뒤에 다시 알려드릴게요.',

  situationLanguage: 'Korean (해요체)',
  filler: /수고\s*하셨|고생\s*하셨|끝나셨죠|좋은\s*하루|화이팅|파이팅|필요하(?:시)?면\s*(?:언제든\s*)?말씀/,
};

const EN: DayTexts = {
  language: 'en',
  allDay: 'All day',
  locationMark: '@',

  prepTitle: 'Tomorrow prep',
  prepLocationCheck: 'Location confirmed',
  prepLocationMissing: 'No location written',
  prepCommitment: (name, text) => `Promise to ${name}: ${text}`,
  prepRelatedMail: (subjects) => `Related mail: ${subjects}`,

  travelUrgent: (title, hhmm, minutes) => `Leave now to make it: ${title} ${hhmm}, about ${minutes} min`,
  travelNote: 'Travel time is a rough estimate.',
  travelAhead: (title, hhmm, place, minutes, leave, mode) =>
    `${title} at ${hhmm} (${place}): about ${String(minutes)} min from here${mode === 'transit' ? ' by transit' : mode === 'car' ? ' by car' : ''}. Leave around ${leave}.${mode === undefined ? ' (rough, straight-line estimate)' : ''}`,

  closeTitle: 'Day close',
  closeEventCount: (count) => `Events: ${count}`,
  closeCompletedCount: (count) => `To-dos done: ${count}`,
  openTodosTitle: 'Still open',
  noOpenTodos: 'Nothing left on your list.',
  markOverdue: '(overdue)',
  markToday: '(today)',
  markTomorrow: '(tomorrow)',
  tomorrowFirst: (label) => `First event tomorrow: ${label}`,
  noTomorrowEvent: 'No events tomorrow.',
  stepsLine: (steps) => `Steps today: ${steps.toLocaleString('en-US')}`,

  repliesTitle: (count) => `${count} mail(s) are waiting for your answer.`,
  replyLine: (from, what, days) => `${from} — ${what} (${days}d ago)`,
  draftChoice: (subject) => `Draft: ${subject}`,
  draftChoiceFor: (number, who) => `Reply to #${number} (${who})`,
  repliesAsk: "Pick one and I'll write a draft to show you first; I always ask before sending. Leave the rest if no answer is needed.",
  noSubject: '(no subject)',
  mailNotConnected: 'Mail is not connected. Gmail needs to be connected.',
  draftFailed: 'Could not write a draft.',
  draftReady: (body) => `Here is a draft. Nothing was sent yet.\n\n${body}`,
  approvalNote: 'Sending goes through the mail approval flow.',

  voiceSummary: (todos, events) => `Added ${todos} to-do(s), ${events} event(s) to confirm`,
  voiceConfirmSummary: (title, when) => `${title} (${when})`,
  voiceConfirmNote: 'An event found in your voice memo',

  stepsNudge: (steps, goal) => `You have walked ${steps.toLocaleString('en-US')} steps today. A little more toward ${goal.toLocaleString('en-US')}?`,
  waterNudge: 'Time for a glass of water.',
  medReminder: (name) => `Time for your medicine: ${name}`,
  medDoneLabel: 'Taken',
  medSnoozeLabel: 'In 10 min',
  medSnoozeAck: 'I will remind you again in 10 minutes.',

  situationLanguage: 'English',
  filler: /\bgood job\b|\bwell done\b|\bhave a (?:nice|great|good) day\b|\blet me know if you need\b|\byou did it\b/i,
};

export function dayTexts(language: string): DayTexts {
  return language === 'en' ? EN : KO;
}
