import type { Effect } from '../../core/policy/types.js';

/**
 * What ax-kit may do with an app, decided by code from its bundle id and name, never by the model.
 * - money:  banks, payments, securities, crypto wallets: read-only.
 * - secret: password managers and Keychain Access: read-only, and field values are never read.
 * - shell:  terminals and script runners: every action asks, with a warning that typed text may run as a command.
 * - system: System Settings: every action asks, with a warning that it changes the Mac itself.
 * - normal: every action asks (the card is never skipped for app control).
 */
export type AppCategory = 'money' | 'secret' | 'shell' | 'system' | 'normal';

export interface AppIdentity {
  name: string;
  bundle: string;
}

const SECRET_BUNDLES = [
  'com.apple.keychainaccess',
  'com.apple.passwords',
  'com.agilebits',
  'com.1password',
  'com.bitwarden',
  'com.lastpass',
  'com.dashlane',
  'org.keepassxc',
  'com.kee',
  'in.sinew.enpass',
  'com.enpass',
  'com.nordpass',
  'com.protonpass',
] as const;
const SECRET_NAME = /1password|keychain|키체인|bitwarden|lastpass|dashlane|keepass|enpass|nordpass|proton pass|^passwords$|^암호$|password manager|비밀번호 관리/i;

const MONEY_BUNDLES = [
  'bank',
  'toss',
  'vivarepublica',
  'kakaopay',
  'naverpay',
  'payco',
  'paypal',
  'wallet',
  'metamask',
  'ledger',
  'exodus',
  'coinbase',
  'binance',
  'upbit',
  'dunamu',
  'bithumb',
  'kiwoom',
  'securities',
  'shinhan',
  'kbstar',
  'wooribank',
  'hanabank',
  'nhbank',
] as const;
const MONEY_NAME =
  /bank|뱅크|은행|toss|토스|\bpay|pay\b|페이|wallet|지갑|증권|securities|stock|trading|coin|코인|crypto|metamask|ledger|exodus|binance|upbit|업비트|bithumb|빗썸|키움|카드사/i;

const SHELL_BUNDLES = [
  'com.apple.terminal',
  'com.googlecode.iterm2',
  'dev.warp.warp',
  'net.kovidgoyal.kitty',
  'org.alacritty',
  'io.alacritty',
  'com.github.wez.wezterm',
  'co.zeit.hyper',
  'com.mitchellh.ghostty',
  'com.apple.scripteditor2',
  'com.apple.automator',
] as const;
const SHELL_NAME = /terminal|터미널|iterm|warp|kitty|alacritty|wezterm|hyper|ghostty|script editor|스크립트 편집기|automator/i;

const SYSTEM_BUNDLES = ['com.apple.systempreferences', 'com.apple.settings', 'com.apple.systemsettings'] as const;
const SYSTEM_NAME = /system settings|system preferences|시스템 설정|시스템 환경설정/i;

const startsWithAny = (bundle: string, list: readonly string[]): boolean => list.some((entry) => bundle.startsWith(entry));
const containsAny = (bundle: string, list: readonly string[]): boolean => list.some((entry) => bundle.includes(entry));

/** The category of an app; the strictest match wins, and an unknown bundle is judged by its name alone. */
export function categorize(app: AppIdentity): AppCategory {
  const bundle = app.bundle.toLowerCase();
  const name = app.name.normalize('NFC').trim();
  if (startsWithAny(bundle, SECRET_BUNDLES) || SECRET_NAME.test(name)) return 'secret';
  if (containsAny(bundle, MONEY_BUNDLES) || MONEY_NAME.test(name)) return 'money';
  if (startsWithAny(bundle, SHELL_BUNDLES) || SHELL_NAME.test(name)) return 'shell';
  if (startsWithAny(bundle, SYSTEM_BUNDLES) || SYSTEM_NAME.test(name)) return 'system';
  return 'normal';
}

/** Why ax-kit refuses to act in this app, or undefined when the owner may approve an action. */
export function actRefusal(category: AppCategory): string | undefined {
  if (category === 'money') return '은행·결제·증권·지갑 앱은 읽기만 해요. 이 앱에서 누르거나 입력하는 건 직접 해 주세요.';
  if (category === 'secret') return '비밀번호 관리 앱과 키체인은 읽기만 해요. 이 앱에서 누르거나 입력하는 건 직접 해 주세요.';
  return undefined;
}

/** The warning on every card; shell and system apps get a sharper one. */
export function cardNote(category: AppCategory): string {
  if (category === 'shell') {
    return '터미널 앱이에요. 입력한 글은 명령으로 실행될 수 있으니 내용을 꼭 확인해 주세요. 승인 없이는 아무것도 하지 않아요.';
  }
  if (category === 'system') return '시스템 설정이에요. 이 맥 전체 설정이 바뀔 수 있으니 확인해 주세요.';
  return '다른 앱을 대신 조작해요. 앱 화면과 대상을 확인해 주세요.';
}

const SECURE_ROLE = 'AXSecureTextField';
const SECRET_FIELD = /password|passcode|비밀번호|암호|\bpin\b|otp|인증 ?번호|보안 ?코드|card number|카드 ?번호|cvc|cvv|주민(등록)? ?번호/i;

/** Password boxes and fields that look like one are never typed into. */
export function secureFieldRefusal(role: string, title: string | undefined): string | undefined {
  if (role === SECURE_ROLE) return '비밀번호 칸에는 입력하지 않아요. 직접 입력해 주세요.';
  if (title !== undefined && SECRET_FIELD.test(title)) {
    return '비밀번호·인증번호·카드 번호 같은 칸에는 입력하지 않아요. 직접 입력해 주세요.';
  }
  return undefined;
}

const SEND_WORDS = /send|submit|post|reply|share|publish|invite|보내기|전송|보내|제출|게시|올리기|답장|공유|초대|등록/i;
const DELETE_WORDS = /delete|remove|trash|erase|discard|clear|empty|삭제|지우기|지워|휴지통|비우기|제거|초기화/i;
const PAY_WORDS = /\bpay\b|buy|purchase|checkout|order|subscribe|결제|구매|구입|주문|송금|이체|충전|구독/i;

/** The effects of pressing or choosing something with this title, on top of the plain `write`. */
export function effectsOfLabel(label: string): Effect[] {
  const effects: Effect[] = ['write'];
  if (SEND_WORDS.test(label)) effects.push('send');
  if (DELETE_WORDS.test(label)) effects.push('delete');
  if (PAY_WORDS.test(label)) effects.push('pay');
  return effects;
}
