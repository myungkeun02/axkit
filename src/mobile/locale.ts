export type MobileLanguage = 'ko' | 'en';
export type PhoneMessageKind = 'sms' | 'notification';

export interface ActionSource {
  kind: PhoneMessageKind;
  /** Sender for an SMS, app name for an app notification. */
  name?: string;
}

export interface DeviceLabel {
  id: string;
  name: string;
}

export interface MobileTexts {
  readonly language: MobileLanguage;
  readonly pairingTitle: string;
  readonly pairingHint: string;
  readonly pairingCodeLabel: string;
  readonly pairingSubmit: string;
  readonly pairingWrong: string;
  readonly pairingExpired: string;
  readonly pairingBurned: string;
  readonly pairingUseApp: string;
  readonly pairingDoneTitle: string;
  readonly pairingDoneHint: string;
  readonly pairingNoFiles: string;
  readonly pairingConnectionLabel: string;
  readonly pairingConnectionHint: string;
  readonly pairingConnectionCopy: string;
  readonly pairingConnectionCopied: string;
  readonly download: string;
  readonly emptySms: string;
  readonly emptyNotification: string;
  readonly emptyVoice: string;
  lockNotice(device: DeviceLabel): string;
  rotateReminder(device: DeviceLabel): string;
  actionNotice(source: ActionSource, action: string): string;
  readonly addTodo: string;
  todoAdded(action: string): string;
  readonly todoOff: string;
  readonly pendingGone: string;
}

const KO: MobileTexts = {
  language: 'ko',
  pairingTitle: '휴대폰 연결',
  pairingHint: '휴대폰 화면에 보이는 6자리 숫자를 입력해 주세요.',
  pairingCodeLabel: '연결 코드',
  pairingSubmit: '확인',
  pairingWrong: '숫자가 맞지 않아요. 다시 입력해 주세요.',
  pairingExpired: '연결 코드가 만료됐어요. 터미널에서 다시 연결해 주세요.',
  pairingBurned: '시도가 너무 많아 연결 코드를 폐기했어요. 터미널에서 다시 연결해 주세요.',
  pairingUseApp: '이 QR은 휴대폰 앱에서 스캔해 주세요. 앱을 열고 "QR로 연결"을 누르면 돼요.',
  pairingDoneTitle: '연결됐어요',
  pairingDoneHint: '아래 파일을 내려받아 휴대폰에 설치해 주세요.',
  pairingNoFiles: '내려받을 파일이 아직 없어요. 터미널 안내를 따라 주세요.',
  pairingConnectionLabel: '연결 문자열',
  pairingConnectionHint:
    'iPhone에서 단축어를 추가할 때 연결 문자열을 물어봐요. 아래 문자열을 복사해서 붙여 넣어 주세요. 이 화면을 닫으면 다시 볼 수 없어요.',
  pairingConnectionCopy: '복사',
  pairingConnectionCopied: '복사했어요',
  download: '내려받기',
  emptySms: '문자 내용이 비어 있어요. 휴대폰 자동화에서 받은 메시지를 함께 보내 주세요.',
  emptyNotification: '알림 내용이 비어 있어요. 휴대폰 자동화에서 받은 알림을 함께 보내 주세요.',
  emptyVoice: '음성 메모 내용이 비어 있어요. 받아쓴 내용을 함께 보내 주세요.',
  lockNotice: (device) =>
    `휴대폰 "${device.name}"(${device.id})에서 잘못된 요청이 10번 연속으로 왔어요. 안전을 위해 이 기기의 연결을 잠갔어요. ` +
    `터미널에서 "ax-kit phone rotate ${device.id}"를 실행해 새 연결 파일을 만들어 주세요.`,
  rotateReminder: (device) =>
    `휴대폰 "${device.name}"(${device.id})의 연결을 마지막으로 바꾼 지 90일이 지났어요. ` +
    `"ax-kit phone rotate ${device.id}"로 새 연결 파일을 만들어 주세요.`,
  actionNotice: (source, action) => {
    const label = source.kind === 'sms' ? '문자' : '알림';
    const head = source.name === undefined ? label : `${label}(${source.name.slice(0, 30)})`;
    return `${head}에서 할 일: ${action}`;
  },
  addTodo: '할 일에 추가',
  todoAdded: (action) => `할 일에 추가했어요: ${action}`,
  todoOff: '할 일 기능이 꺼져 있어서 추가하지 못했어요.',
  pendingGone: '이 버튼은 이미 처리됐거나 만료됐어요.',
};

const EN: MobileTexts = {
  language: 'en',
  pairingTitle: 'Connect your phone',
  pairingHint: 'Enter the 6-digit number shown on your phone.',
  pairingCodeLabel: 'Connection code',
  pairingSubmit: 'Continue',
  pairingWrong: 'That number is not right. Please try again.',
  pairingExpired: 'This connection code has expired. Run the pairing command again in the terminal.',
  pairingBurned: 'Too many attempts, so the code was discarded. Run the pairing command again in the terminal.',
  pairingUseApp: 'Scan this QR code from the phone app: open it and tap "Connect with QR".',
  pairingDoneTitle: 'Connected',
  pairingDoneHint: 'Download the files below and install them on your phone.',
  pairingNoFiles: 'There are no files to download yet. Follow the terminal instructions.',
  pairingConnectionLabel: 'Connection string',
  pairingConnectionHint:
    'The shortcut asks for a connection string when you add it on your iPhone. Copy the string below and paste it there. You cannot see it again after leaving this page.',
  pairingConnectionCopy: 'Copy',
  pairingConnectionCopied: 'Copied',
  download: 'Download',
  emptySms: 'The message text is empty. Send the received message from your phone automation.',
  emptyNotification: 'The notification text is empty. Send the received notification from your phone automation.',
  emptyVoice: 'The voice memo text is empty. Send the transcribed text with it.',
  lockNotice: (device) =>
    `Phone "${device.name}" (${device.id}) sent 10 bad requests in a row, so its connection was locked. ` +
    `Run "ax-kit phone rotate ${device.id}" in the terminal to make a new connection file.`,
  rotateReminder: (device) =>
    `Phone "${device.name}" (${device.id}) was last rotated 90 days ago. ` +
    `Run "ax-kit phone rotate ${device.id}" to make a new connection file.`,
  actionNotice: (source, action) => {
    const label = source.kind === 'sms' ? 'SMS' : 'Notification';
    const head = source.name === undefined ? label : `${label} (${source.name.slice(0, 30)})`;
    return `${head} asks you to: ${action}`;
  },
  addTodo: 'Add to to-do',
  todoAdded: (action) => `Added to your to-do: ${action}`,
  todoOff: 'The to-do skill is off, so it was not added.',
  pendingGone: 'This button was already handled or has expired.',
};

export function mobileTexts(language: string): MobileTexts {
  return language === 'en' ? EN : KO;
}
