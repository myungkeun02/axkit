import type { Config } from '../core/config/schema.js';
import type { PhoneAdminHandle } from '../app/phone.js';
import type { MobilePlatform } from '../mobile/index.js';
import type { Prompter } from './prompter.js';

/** What the owner reads after pairing: plain words, not the developers' protocol document. */
const APP_GUIDE = '앱이 연결되면 앱 화면 위쪽에 비서 이름이 보여요. 안 되면 앱 설정에서 "다시 연결"을 누르고 새 코드를 받으세요 (ax-kit phone pair --app).';

export interface ApkBuilder {
  /** The last built APK, if one exists. */
  existing(): Promise<string | undefined>;
  /** Builds and signs with this Mac's key; returns the APK path. */
  build(): Promise<string>;
}

export interface PhoneAppDeps {
  home: string;
  prompter: Prompter;
  say(line: string): void;
  openAdmin(home: string): PhoneAdminHandle;
  qr(text: string): Promise<string>;
  apk?: ApkBuilder;
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/** The QR the app scans. A phone camera that does not know the scheme just shows text; the code still expires in 10 min. */
export function appPairingLink(publicUrl: string, nonce: string, code: string): string {
  return `axkit://pair?u=${encodeURIComponent(trimUrl(publicUrl))}&n=${encodeURIComponent(nonce)}&c=${code}`;
}

/**
 * `phone pair --app [--platform desktop|ios|android]`: the token is handed to the app over HTTPS after the scan; it is
 * never printed here. The link line holds only the one-time pairing code, which expires in 10 minutes.
 */
export async function pairAppDevice(
  deps: PhoneAppDeps,
  config: Config,
  publicUrl: string,
  name: string,
  platform: MobilePlatform = 'android',
): Promise<number> {
  const handle = deps.openAdmin(deps.home);
  try {
    const result = await handle.admin.pair({ name, platform, client: 'app' });
    await handle.admin.attachFiles(result.pairing.nonce, [], `${trimUrl(publicUrl)}|${result.token}`);
    const link = appPairingLink(publicUrl, result.pairing.nonce, result.pairing.code);
    deps.say(await deps.qr(link));
    deps.say(
      platform === 'desktop'
        ? '데스크톱 앱의 "링크로 연결"에 아래 링크를 붙여 넣어 주세요. (10분 안에, 한 번만 쓸 수 있어요)'
        : `앱에서 "QR로 연결"을 누르고 위 QR을 찍어 주세요. (10분 안에, 한 번만 쓸 수 있어요)`,
    );
    deps.say(`링크: ${link}`);
    deps.say(`QR이 안 되면 앱에 직접 입력: 주소 ${trimUrl(publicUrl)} · 코드 ${result.pairing.code} · 연결 id ${result.pairing.nonce}`);
    deps.say(`기기: ${result.device.name} (${result.device.id}) · 비서: ${config.assistant.name}`);
    deps.say(APP_GUIDE);
  } finally {
    await handle.close();
  }
  return 0;
}

/** `phone apk`: builds (or reuses) the APK and shows a 30-minute download QR plus the install steps. */
export async function apkCommand(deps: PhoneAppDeps, publicUrl: string | undefined, rebuild: boolean): Promise<number> {
  if (deps.apk === undefined) {
    deps.say('이 설치에는 Android 앱 소스(android/)가 없어요.');
    return 1;
  }
  let path = rebuild ? undefined : await deps.apk.existing();
  if (path === undefined) {
    deps.say('앱을 빌드하고 이 Mac의 키로 서명할게요. 처음에는 몇 분 걸려요.');
    path = await deps.apk.build();
  }
  deps.say(`APK: ${path}`);
  if (publicUrl === undefined) {
    deps.say('공개 주소가 없어 내려받기 QR을 만들 수 없어요. 파일을 휴대폰으로 직접 옮겨 주세요(USB, 메일 등).');
  } else {
    const handle = deps.openAdmin(deps.home);
    try {
      const link = await handle.apk.create(path);
      const url = `${trimUrl(publicUrl)}/m/apk/${link.nonce}`;
      deps.say(await deps.qr(url));
      deps.say(`내려받기 링크(30분): ${url}`);
    } finally {
      await handle.close();
    }
  }
  deps.say('설치 순서:');
  deps.say('1) 휴대폰 카메라로 QR을 찍어 APK를 내려받아요.');
  deps.say('2) 파일을 열면 "알 수 없는 앱 설치" 허용을 물어요 → 허용.');
  deps.say('3) 설치 → 열기.');
  deps.say('4) 이 Mac에서 `ax-kit phone pair --app` → 앱에서 "QR로 연결".');
  deps.say(APP_GUIDE);
  return 0;
}
