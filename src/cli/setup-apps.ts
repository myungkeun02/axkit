import { chooseMany } from './prompt-kit.js';
import type { Prompter } from './prompter.js';

export type AppDevice = 'ios' | 'android' | 'this-mac' | 'other-mac';

/** Where each app is installed from; empty until this installation has a link for it. */
export interface AppLinks {
  ios?: string;
  android?: string;
  desktop?: string;
}

export interface AppStepDeps {
  /** `ax-kit phone pair --app`: shows the QR / link and waits for nothing (the code lasts 10 minutes). */
  pair: (platform: 'ios' | 'android' | 'desktop', name: string) => Promise<number>;
  /** `ax-kit phone funnel [--fix]`: 0 when phones can reach this Mac. */
  funnel: (fix: boolean) => Promise<number>;
  desktopInstalled: () => Promise<boolean>;
  /** Installs and pairs the desktop app on a Mac picked from the tailnet; 0 when done. */
  installMac?: () => Promise<number>;
  links: AppLinks;
  /** Whether any app can be got here (an install link, the Mac app installed or ready to hand out). */
  available?: () => Promise<boolean>;
  openUrl?: (url: string) => Promise<void>;
}

const OPTIONS: readonly { value: AppDevice; label: string }[] = [
  { value: 'ios', label: '아이폰 앱' },
  { value: 'android', label: '안드로이드 앱' },
  { value: 'this-mac', label: '이 맥의 데스크톱 앱' },
  { value: 'other-mac', label: '다른 맥(업무용 맥북 등)의 데스크톱 앱' },
];

async function waitInstalled(prompter: Prompter, what: string): Promise<boolean> {
  const answer = (await prompter.text(`${what} 설치했으면 엔터 (안 하려면 "건너뛰기")`, { default: '' })).trim();
  return answer !== '건너뛰기' && answer.toLowerCase() !== 'skip';
}

async function ensureReachable(prompter: Prompter, deps: AppStepDeps): Promise<boolean> {
  prompter.say('휴대폰·다른 맥은 Tailscale로 이 맥에 붙어요. 그 기기에도 Tailscale을 깔고 같은 계정으로 로그인해 주세요.');
  if ((await deps.funnel(false)) === 0) return true;
  const fix = await prompter.choose(
    '다른 기기가 이 맥에 닿을 주소가 아직 준비되지 않았어요. 지금 준비할까요?',
    [
      { value: 'fix', label: '지금 준비 (추천)', hint: 'ax-kit phone funnel --fix' },
      { value: 'later', label: '나중에', hint: '그때는 ax-kit phone funnel --fix 후 ax-kit phone pair --app' },
    ],
    0,
  );
  return fix === 'fix' && (await deps.funnel(true)) === 0;
}

function installLine(link: string | undefined, fallback: string): string {
  return link !== undefined && link !== '' ? `설치: ${link}` : fallback;
}

/**
 * The last step of setup: which apps the owner will talk to the assistant in, how to install each, and pairing right
 * here (a QR or a link). Returns the devices that were paired or are ready.
 */
export async function askApps(prompter: Prompter, deps: AppStepDeps): Promise<AppDevice[]> {
  const picked = (await chooseMany(prompter, '어디서 비서와 이야기할까요? (여러 개 골라도 돼요)', OPTIONS.map((option) => ({ ...option, checked: option.value === 'ios' })))) as AppDevice[];
  if (picked.length === 0) {
    prompter.say('앱은 나중에 연결할 수 있어요: ax-kit phone pair --app 데스크톱·휴대폰 앱의 설정에서도 연결할 수 있어요.');
    return [];
  }
  const ready: AppDevice[] = [];
  const remote = picked.filter((device) => device !== 'this-mac');
  const reachable = remote.length === 0 || (await ensureReachable(prompter, deps));

  if (picked.includes('this-mac')) {
    if (await deps.desktopInstalled()) prompter.say('✓ 이 맥에 데스크톱 앱이 있어요. 열면 짝 맞추기 없이 바로 이 맥의 비서에 붙어요.');
    else prompter.say(installLine(deps.links.desktop, '데스크톱 앱: ax-kit-desktop 저장소에서 `npm run install-app`으로 설치해요. 열면 바로 이 맥의 비서에 붙어요.'));
    ready.push('this-mac');
  }
  if (!reachable) {
    if (remote.length > 0) prompter.say('주소가 준비되면 `ax-kit phone pair --app`으로 연결해 주세요.');
    return ready;
  }
  for (const device of remote) {
    if (device === 'ios') {
      prompter.say(installLine(deps.links.ios, '아이폰: App Store에서 TestFlight를 받고, 받은 ax-kit TestFlight 초대 링크를 열어 설치해요.'));
      if (deps.links.ios !== undefined) await deps.openUrl?.(deps.links.ios).catch(() => undefined);
      if (!(await waitInstalled(prompter, '아이폰 앱을'))) continue;
      prompter.say('아이폰 앱에서 "QR로 연결"을 누르고 아래 QR을 찍어 주세요.');
      if ((await deps.pair('ios', '아이폰')) === 0) ready.push('ios');
    } else if (device === 'android') {
      prompter.say(installLine(deps.links.android, '안드로이드: 받은 ax-kit APK 파일을 휴대폰에서 열어 설치해요 (출처를 알 수 없는 앱 허용이 필요할 수 있어요).'));
      if (!(await waitInstalled(prompter, '안드로이드 앱을'))) continue;
      prompter.say('안드로이드 앱에서 "QR로 연결"을 누르고 아래 QR을 찍어 주세요.');
      if ((await deps.pair('android', '안드로이드')) === 0) ready.push('android');
    } else if (deps.installMac !== undefined) {
      prompter.say('업무용 맥에 데스크톱 앱을 설치하고 이 비서와 연결해 둘게요.');
      if ((await deps.installMac()) === 0) ready.push('other-mac');
    } else {
      prompter.say(installLine(deps.links.desktop, '다른 맥: 그 맥에 ax-kit 데스크톱 앱을 설치해요 (ax-kit-desktop 저장소의 `npm run install-app`).'));
      if (!(await waitInstalled(prompter, '그 맥에 데스크톱 앱을'))) continue;
      prompter.say('그 맥의 앱 첫 화면에서 "다른 맥의 비서에 연결"을 누르고 아래 링크를 붙여 넣어 주세요.');
      if ((await deps.pair('desktop', '다른 맥')) === 0) ready.push('other-mac');
    }
  }
  prompter.say('연결 코드는 10분 동안 한 번만 쓸 수 있어요. 앱 설정에서도 다시 연결할 수 있어요. 지나면 `ax-kit phone pair --app`으로 새로 받으면 돼요.');
  return ready;
}

/** Install links from this installation's environment (the maintainer fills them in for their testers). */
export function appLinksFromEnv(env: NodeJS.ProcessEnv = process.env): AppLinks {
  const pick = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value !== undefined && value !== '' ? value : undefined;
  };
  const ios = pick('AX_KIT_IOS_INSTALL_URL');
  const android = pick('AX_KIT_ANDROID_INSTALL_URL');
  const desktop = pick('AX_KIT_DESKTOP_INSTALL_URL');
  return { ...(ios !== undefined ? { ios } : {}), ...(android !== undefined ? { android } : {}), ...(desktop !== undefined ? { desktop } : {}) };
}
