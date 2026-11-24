/** User-visible sentences for the assistant skill. Korean is the default. */
export interface AssistantTexts {
  /** The model sent something that is not a usable plan, twice. */
  invalidPlan: string;
  /** The plan had no reply and no question. */
  emptyReply: string;
  /** The daily AI budget is used up. */
  overBudget: string;
  /** The monthly AI budget is used up. */
  overBudgetMonthly: string;
  noRoute: string;
  providerFailed: string;
  /** Used when the owner did not configure a name for themselves. */
  ownerFallback: string;
  /** Tools ran, then the model stopped: the head of a reply built from what the tools returned. */
  partialHead: string;
  /** …and its last line. */
  partialTail: string;
  /** In front of the reply to a turn a restart cut off after tools with effects had run. */
  resumed: string;
}

const KO: AssistantTexts = {
  invalidPlan: '제가 답을 제대로 만들지 못했어요. 한 번 더 보내 주시면 다시 해 볼게요.',
  emptyReply: '확인했어요. 더 필요한 게 있으면 말씀해 주세요.',
  overBudget: '오늘 정한 AI 사용 예산을 다 써서 지금은 답할 수 없어요. 내일 다시 쓸 수 있어요.',
  overBudgetMonthly: '이번 달 AI 사용 예산을 다 써서 지금은 답할 수 없어요. 다음 달에 다시 쓸 수 있고, 설정에서 월 예산을 늘릴 수도 있어요.',
  noRoute: 'AI 공급자가 아직 설정되지 않았어요. 터미널에서 ax-kit setup 을 실행해 주세요.',
  providerFailed: 'AI 공급자에 연결하지 못했어요. 잠시 뒤 다시 말씀해 주세요.',
  ownerFallback: '주인',
  partialHead: '정리하다 멈췄는데, 여기까지는 해 뒀어요:',
  partialTail: '이어서 마무리할까요?',
  resumed: '재시작으로 중간에 멈췄었어요.',
};

const EN: AssistantTexts = {
  invalidPlan: "I couldn't put my answer together properly. Send it once more and I'll try again.",
  emptyReply: 'Okay. Let me know if there is anything else you need.',
  overBudget: "I have used up today's AI budget, so I cannot answer right now. It resets tomorrow.",
  overBudgetMonthly: "I have used up this month's AI budget, so I cannot answer right now. It resets next month, or you can raise the monthly budget in settings.",
  noRoute: 'No AI provider is configured yet. Run ax-kit setup in the terminal.',
  providerFailed: 'I could not reach the AI provider. Please try again in a moment.',
  ownerFallback: 'the owner',
  partialHead: 'I stopped while wrapping up, but this much is done:',
  partialTail: 'Shall I finish the rest?',
  resumed: 'A restart cut me off midway.',
};

export function assistantTexts(language: string): AssistantTexts {
  return language === 'en' ? EN : KO;
}
