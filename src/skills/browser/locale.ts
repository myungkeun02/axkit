import type { HandoffReason } from '../../core/contracts/index.js';

export type BrowserLanguage = 'ko' | 'en';

export interface BrowserTexts {
  readonly language: BrowserLanguage;
  /** What the owner should do on the Mac, plus how to reach it remotely and how to continue. */
  guide(reason: HandoffReason, url: string | undefined, inApp?: boolean): string;
  taskDescription(goal: string, startUrl: string | undefined): string;
  openDescription(url: string): string;
  opened(url: string): string;
  readonly openUnavailable: string;
  /** The page waits in the app's browser screen (`browser-live`). */
  openedInApp(url: string): string;
  /** Card shown before a code is typed on a money-grade site or a money-moving step. */
  authConfirm(host: string): string;
  readonly authConfirmNote: string;
  /** Line added to the task card when codes may be typed on this run. */
  readonly autoAuthOn: string;
  /** The run stopped before a final button: how the owner lets the browser press exactly that one. */
  buttonGuide(button: string): string;
  /** Card line for a run that may press one approved final button. */
  pressButton(button: string): string;
  readonly pressButtonNote: string;
  /** Background task results, sent through the notifier. Page-derived text follows as quoted data. */
  taskDone(goal: string, text: string): string;
  taskStopped(goal: string, guide: string): string;
  taskFailed(goal: string, error: string): string;
}

const MAX_RESULT_CHARS = 1500;
const clip = (text: string): string => (text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS - 1)}…` : text);

function koReason(reason: HandoffReason): string {
  switch (reason) {
    case 'login':
      return '맥 화면에서 직접 로그인해 주세요.';
    case 'payment':
      return '결제는 직접 해 주세요 — 비서는 결제 정보를 입력하지 않아요.';
    case 'consent':
      return '약관은 직접 읽고 동의해 주세요.';
    case 'captcha':
      return '로봇이 아닌지 확인하는 창은 직접 풀어 주세요.';
    case 'other':
      return '이 화면은 직접 처리해 주세요.';
  }
}

function enReason(reason: HandoffReason): string {
  switch (reason) {
    case 'login':
      return 'Please sign in yourself on the Mac screen.';
    case 'payment':
      return 'Please pay yourself — the assistant does not enter payment details.';
    case 'consent':
      return 'Please read and accept the terms yourself.';
    case 'captcha':
      return 'Please solve the robot check yourself.';
    case 'other':
      return 'Please handle this screen yourself.';
  }
}

const KO_REMOTE =
  '밖에 있다면 휴대폰이나 다른 컴퓨터에서 화면 공유(macOS 화면 공유, vnc://<이 맥 주소>)로 들어가 할 수 있어요.';
const EN_REMOTE =
  'If you are out, you can use Screen Sharing from your phone or another computer (macOS Screen Sharing, vnc://<this Mac address>).';

const KO_APP = "앱의 브라우저 화면에서 직접 하실 수 있어요. 다 하셨으면 그 화면에서 '다 했어요'를 눌러 주세요.";
const EN_APP = `You can do it yourself in the app's browser screen. Tap "Done" there when you finish.`;

const KO: BrowserTexts = {
  language: 'ko',
  guide(reason, url, inApp) {
    const lines: string[] = [];
    if (url !== undefined) lines.push(url);
    lines.push(koReason(reason));
    if (inApp === true) lines.push(KO_APP);
    lines.push(KO_REMOTE);
    lines.push("끝나면 '계속'이라고 말해 주세요.");
    lines.push("원하면 '화면에 열어 줘'라고 말해 주세요 — 이 맥의 화면에 같은 브라우저로 열어 드려요.");
    return lines.join('\n');
  },
  taskDescription(goal, startUrl) {
    const where = startUrl === undefined ? '' : `\n시작 주소: ${startUrl}`;
    return `브라우저 심부름: ${goal}${where}\n로그인·결제·약관 동의는 하지 않고 그 화면에서 멈춰요.`;
  },
  openDescription: (url) => `맥 화면에 열기: ${url}`,
  opened: () => "맥 화면에 열었어요. 하실 일을 마친 뒤 '계속'이라고 말해 주세요.",
  openUnavailable: '지금은 화면에 열 수 없어요. 맥에서 직접 열어 주세요.',
  openedInApp: () => "앱의 브라우저 화면에 준비해 뒀어요. 그 화면에서 직접 하시고 '다 했어요'를 눌러 주세요.",
  authConfirm: (host) => `${host} 인증 화면에 휴대폰으로 온 인증번호를 넣을까요?`,
  authConfirmNote: '금융·통신 사이트이거나 돈이 오가는 단계라 먼저 여쭤봐요. 결제는 여전히 직접 하셔야 해요.',
  autoAuthOn: '허용한 사이트라서 문자·메일로 온 인증번호는 비서가 넣어요(결제는 안 해요).',
  buttonGuide: (button) => `'${button}' 버튼은 마지막 단계라 멈췄어요. 직접 누르시거나, 비서가 눌러도 되면 '눌러도 돼'라고 말해 주세요.`,
  pressButton: (button) => `이번에는 '${button}' 버튼까지 눌러요.`,
  pressButtonNote: '예약·신청 같은 마지막 단계라 이 카드에서 직접 허락해 주셔야 해요. 결제 버튼은 누르지 않아요.',
  taskDone: (goal, text) => `브라우저 심부름 '${goal}'을(를) 마쳤어요.${text.trim() === '' ? '' : `\n\n${clip(text.trim())}`}`,
  taskStopped: (goal, guide) => `브라우저 심부름 '${goal}'이(가) 직접 하실 단계에서 멈췄어요.\n${guide}`,
  taskFailed: (goal, error) => `브라우저 심부름 '${goal}'을(를) 마치지 못했어요. ${clip(error)}`,
};

const EN: BrowserTexts = {
  language: 'en',
  guide(reason, url, inApp) {
    const lines: string[] = [];
    if (url !== undefined) lines.push(url);
    lines.push(enReason(reason));
    if (inApp === true) lines.push(EN_APP);
    lines.push(EN_REMOTE);
    lines.push('Say "continue" when you are done.');
    lines.push('Say "open it on screen" if you want it opened in a browser window on this Mac.');
    return lines.join('\n');
  },
  taskDescription(goal, startUrl) {
    const where = startUrl === undefined ? '' : `\nStart address: ${startUrl}`;
    return `Browser errand: ${goal}${where}\nIt stops at login, payment and consent screens and does not go further.`;
  },
  openDescription: (url) => `Open on this Mac's screen: ${url}`,
  opened: () => 'Opened it on this Mac\'s screen. Say "continue" when you are done.',
  openUnavailable: 'I cannot open it on screen right now. Please open it yourself on the Mac.',
  openedInApp: () => `It is ready in the app's browser screen. Do it there and tap "Done" when you finish.`,
  authConfirm: (host) => `Type the code your phone received into the ${host} verification page?`,
  authConfirmNote: 'This is a money-grade site or a step that moves money, so I ask first. Payments are still yours to make.',
  autoAuthOn: 'This site is on your allowed list, so I will type codes that arrive by text or mail (never payments).',
  buttonGuide: (button) => `It stopped before "${button}" because it is a final step. Press it yourself, or say "go ahead and press it".`,
  pressButton: (button) => `This time it presses the "${button}" button too.`,
  pressButtonNote: 'This is a final step such as a booking or a submission, so it needs your yes on this card. Payment buttons are never pressed.',
  taskDone: (goal, text) => `Finished the browser errand '${goal}'.${text.trim() === '' ? '' : `\n\n${clip(text.trim())}`}`,
  taskStopped: (goal, guide) => `The browser errand '${goal}' stopped at a step that is yours.\n${guide}`,
  taskFailed: (goal, error) => `The browser errand '${goal}' did not finish. ${clip(error)}`,
};

export function browserTexts(language: string): BrowserTexts {
  return language === 'en' ? EN : KO;
}
