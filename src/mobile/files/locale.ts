export type ShortcutKind = 'location' | 'sms' | 'steps' | 'voice_memo';

export interface MobileFileTexts {
  readonly language: 'ko' | 'en';
  readonly shortcutLabels: Readonly<Record<ShortcutKind, string>>;
  readonly macroLabels: Readonly<Record<'notification' | 'location' | 'battery', string>>;
  readonly sent: string;
  /** Import question shown when the generic template asks for `<url>|<token>`. */
  readonly connectionQuestion: string;
}

const KO: MobileFileTexts = {
  language: 'ko',
  shortcutLabels: { location: '위치', sms: '문자', steps: '걸음', voice_memo: '메모' },
  macroLabels: { notification: '알림', location: '위치', battery: '배터리' },
  sent: '보냈어요',
  connectionQuestion: '연결 문자열을 붙여 넣어 주세요',
};

const EN: MobileFileTexts = {
  language: 'en',
  shortcutLabels: { location: 'Location', sms: 'Message', steps: 'Steps', voice_memo: 'Memo' },
  macroLabels: { notification: 'Notifications', location: 'Location', battery: 'Battery' },
  sent: 'Sent',
  connectionQuestion: 'Paste the connection string',
};

export function fileTexts(language: string): MobileFileTexts {
  return language === 'en' ? EN : KO;
}
