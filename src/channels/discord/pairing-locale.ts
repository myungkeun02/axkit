export interface PairingTexts {
  paired: string;
  wrongCode: string;
  hint: string;
}

const KO: PairingTexts = {
  paired: '연결됐어요. 이제 당신의 메시지만 지시로 받아요.',
  wrongCode: '코드가 맞지 않아요. 터미널에 표시된 6자리 코드를 다시 보내 주세요.',
  hint: '터미널에 표시된 6자리 숫자 코드를 이 대화로 보내 주세요.',
};

const EN: PairingTexts = {
  paired: 'Connected. From now on I take instructions only from your messages.',
  wrongCode: 'That code is not right. Please send the 6-digit code shown in the terminal again.',
  hint: 'Send the 6-digit code shown in the terminal to this chat.',
};

export function pairingTexts(language: string): PairingTexts {
  return language === 'en' ? EN : KO;
}
