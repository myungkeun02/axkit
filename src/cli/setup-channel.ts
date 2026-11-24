import type { Config } from '../core/config/schema.js';
import type { Prompter } from './prompter.js';

export type ChannelMode = Config['channel'];

const MODES: readonly ChannelMode[] = ['app', 'discord', 'both'];

/**
 * Where the owner talks to the assistant: one question. iPhone (TestFlight), Android and the Mac app all speak the app
 * protocol, so the app comes first and needs nothing else here; Discord asks for a bot of your own.
 */
export async function askChannel(prompter: Prompter, existing: Config | undefined, appsAvailable = true): Promise<ChannelMode> {
  const answer = await prompter.choose(
    '비서와 어디서 대화할까요?',
    [
      // the app is recommended only where there is a way to get it (an install link, or the app already here)
      appsAvailable
        ? { value: 'app', label: '휴대폰·맥 앱 (추천)', hint: 'iPhone·Android·맥 앱 모두 돼요. 설정이 끝나면 QR로 연결해요.' }
        : { value: 'app', label: '휴대폰·맥 앱', hint: '앱을 받을 링크가 아직 없어요. 앱을 이미 받았을 때만 고르세요.' },
      { value: 'discord', label: '디스코드', hint: '내 디스코드 봇을 만들어야 해요 (5분쯤, 안내해 드려요).' },
      { value: 'both', label: '앱 + 디스코드', hint: '확인 카드는 먼저 누른 쪽으로 처리해요.' },
    ],
    Math.max(0, MODES.indexOf(existing?.channel ?? (appsAvailable ? 'app' : 'discord'))),
  );
  return MODES.find((mode) => mode === answer) ?? 'app';
}

export function channelLabel(mode: ChannelMode): string {
  if (mode === 'app') return '휴대폰 앱';
  if (mode === 'both') return '휴대폰 앱 + 디스코드';
  return '디스코드';
}

/**
 * The app is installed and paired from the CLI after setup. Away from home it reaches this Mac over Tailscale, only
 * between the owner's own devices; nothing is opened to the internet.
 */
export function appNextSteps(say: (line: string) => void): void {
  say('휴대폰 앱 연결:');
  say('  1) Tailscale: 이 맥과 휴대폰에 설치하고 같은 계정으로 로그인 (밖에서도 내 기기끼리만 연결돼요)');
  say('  2) 앱 설치: 아이폰은 TestFlight 초대 링크로, 안드로이드는 ax-kit phone apk 로 나온 QR로');
  say('  3) ax-kit phone pair --app --platform ios   (안드로이드는 --platform android, 앱에서 "QR로 연결")');
  say('  맥 데스크톱 앱은 짝 맞추기 없이 바로 이 맥의 서버에 붙어요.');
}
