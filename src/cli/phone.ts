import { join } from 'node:path';
import type { Config } from '../core/config/schema.js';
import { phoneFilesDir } from '../app/phone.js';
import type { PhoneAdminHandle, PreparePhoneFilesResult, PreparePhoneFilesSpec } from '../app/phone.js';
import type { PairingResult } from '../mobile/index.js';
import type { MobilePlatform } from '../mobile/index.js';
import { buildIosImportTemplates } from '../mobile/files/index.js';
import type { Prompter } from './prompter.js';
import type { TailscaleStatus } from './tailscale.js';
import type { ApkBuilder } from './phone-app.js';
import { apkCommand, pairAppDevice } from './phone-app.js';
import { printUnsignedGuide } from './phone-ios.js';
import { listCommand } from './phone-list.js';

const FUNNEL_GUIDE = 'docs/guides/tailscale-funnel.md';
const IOS_GUIDE = 'docs/guides/phone-ios.md';
const ANDROID_GUIDE = 'docs/guides/phone-android.md';
const FUNNEL_FIX = 'tailscale funnel --bg --set-path /m http://127.0.0.1:47617/m';
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const ACTIONS = ['pair', 'list', 'rotate', 'revoke', 'template', 'funnel', 'apk', 'push-test', 'install-mac'] as const;

const USAGE = `사용법:
  ax-kit phone pair [--platform ios|android] [--name <기기 이름>]
  ax-kit phone pair --app [--platform desktop|ios|android] [--name <기기 이름>]   앱 연결(QR·링크)
  ax-kit phone install-mac [--to <맥 이름>] [--user <그 맥 사용자>]   다른 맥에 데스크톱 앱 설치·연결(Tailscale)
  ax-kit phone apk [--build]                         앱 설치 파일·설치 QR
  ax-kit phone list
  ax-kit phone rotate <기기 id>
  ax-kit phone revoke <기기 id> [--yes]
  ax-kit phone template --out <폴더> [--yes]
  ax-kit phone funnel [--fix]
  ax-kit phone push-test [<기기 id>]                 폰 앱에 시험 푸시(APNs 키가 있을 때)`;

const NO_CONFIG = '설정이 없어요. 먼저 `ax-kit setup`을 실행해 주세요.';

export interface PhoneFlags {
  platform?: string;
  name?: string;
  yes?: boolean;
  out?: string;
  fix?: boolean;
  app?: boolean;
  build?: boolean;
  /** `install-mac --to <tailnet Mac>` and `--user <its user name>`. */
  to?: string;
  user?: string;
}

export interface PhoneCliDeps {
  home: string;
  prompter: Prompter;
  say(line: string): void;
  openAdmin(home: string): PhoneAdminHandle;
  prepare(input: PreparePhoneFilesSpec): Promise<PreparePhoneFilesResult>;
  tailscale(): Promise<TailscaleStatus>;
  qr(text: string): Promise<string>;
  loadConfig(): Promise<Config | undefined>;
  mkdir(path: string, mode: number): Promise<void>;
  writeFile(path: string, data: string, mode: number): Promise<void>;
  /** Missing directories read as empty. */
  readDir(path: string): Promise<string[]>;
  funnel(flags: { fix?: boolean }): Promise<number>;
  apk?: ApkBuilder;
  /** `phone push-test`: one APNs test push per registered phone (or the one named). */
  pushTest?(deviceId?: string): Promise<number>;
  /** `phone install-mac`: the desktop app on another Mac of the tailnet, installed and paired. */
  installMac?(config: Config, publicUrl: string, options: { to?: string; user?: string }): Promise<number>;
  /** Injected in tests so "last signal 3 h ago" is deterministic. */
  now?(): Date;
}

function guideFor(platform: MobilePlatform): string {
  return platform === 'android' ? ANDROID_GUIDE : IOS_GUIDE;
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function expiryText(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('ko-KR', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

async function resolvePublicUrl(deps: PhoneCliDeps, config: Config): Promise<string | undefined> {
  const configured = config.plugins['bridge.mobile']?.publicUrl;
  if (typeof configured === 'string' && configured.trim().length > 0) return trimUrl(configured.trim());
  const status = await deps.tailscale();
  if (status.dnsName === undefined || status.dnsName.length === 0) return undefined;
  return `https://${status.dnsName}`;
}

function printFunnelGuide(deps: PhoneCliDeps): number {
  deps.say('공개 주소를 찾지 못했어요. 휴대폰이 밖에서 접속하려면 Tailscale Funnel이 필요해요.');
  deps.say(`안내: ${FUNNEL_GUIDE}`);
  deps.say(`명령: ${FUNNEL_FIX}`);
  return 1;
}

function platformOf(value: string | undefined): MobilePlatform | undefined {
  return value === 'ios' || value === 'android' ? value : undefined;
}

function appPlatformOf(value: string): MobilePlatform | undefined {
  return value === 'desktop' ? 'desktop' : platformOf(value);
}

async function askPlatform(deps: PhoneCliDeps, flag: string | undefined): Promise<MobilePlatform | undefined> {
  if (flag !== undefined) return platformOf(flag);
  const answer = await deps.prompter.choose('어떤 휴대폰을 연결할까요?', [
    { value: 'ios', label: 'iPhone (iOS 단축어)' },
    { value: 'android', label: 'Android (MacroDroid)' },
  ], 0);
  return platformOf(answer);
}

async function attachAndShow(
  deps: PhoneCliDeps,
  admin: PhoneAdminHandle['admin'],
  config: Config,
  publicUrl: string,
  result: PairingResult,
): Promise<void> {
  const filesDir = phoneFilesDir(deps.home, result.pairing.nonce);
  const prepared = await deps.prepare({
    platform: result.device.platform,
    assistantName: config.assistant.name,
    language: config.assistant.language,
    publicUrl,
    token: result.token,
    nonce: result.pairing.nonce,
    filesDir,
  });
  await admin.attachFiles(result.pairing.nonce, prepared.files, prepared.connection);

  const link = `${trimUrl(publicUrl)}/m/p/${result.pairing.nonce}`;
  deps.say(await deps.qr(link));
  deps.say(`링크: ${link}`);
  deps.say(`페어링 코드: ${result.pairing.code}`);
  deps.say(
    `만료: ${expiryText(result.pairing.expiresAt, config.assistant.timezone)} (10분) 파일: ${prepared.files.length}개`,
  );
  if (prepared.unsigned) printUnsignedGuide(deps, config);
  deps.say(`기기: ${result.device.name} (${result.device.id})`);
  deps.say(`안내: ${guideFor(result.device.platform)}`);
}

async function pairCommand(deps: PhoneCliDeps, flags: PhoneFlags): Promise<number> {
  const config = await deps.loadConfig();
  if (config === undefined) {
    deps.say(NO_CONFIG);
    return 1;
  }
  const publicUrl = await resolvePublicUrl(deps, config);
  if (publicUrl === undefined) return printFunnelGuide(deps);
  if (flags.app === true) {
    const appPlatform = flags.platform === undefined ? 'android' : appPlatformOf(flags.platform);
    if (appPlatform === undefined) {
      deps.say('--platform은 desktop, ios, android만 돼요.');
      return 2;
    }
    const defaultName = appPlatform === 'desktop' ? '내 데스크톱 앱' : appPlatform === 'ios' ? '내 아이폰 앱' : '내 휴대폰 앱';
    return await pairAppDevice(deps, config, publicUrl, flags.name ?? defaultName, appPlatform);
  }

  const platform = await askPlatform(deps, flags.platform);
  if (platform === undefined) {
    deps.say('--platform은 ios 또는 android만 돼요.');
    return 2;
  }
  const name =
    flags.name ??
    (await deps.prompter.text('기기 이름', { default: platform === 'ios' ? '내 아이폰' : '내 안드로이드' }));

  const handle = deps.openAdmin(deps.home);
  try {
    const result = await handle.admin.pair({ name, platform });
    await attachAndShow(deps, handle.admin, config, publicUrl, result);
  } finally {
    await handle.close();
  }
  return 0;
}

async function rotateCommand(deps: PhoneCliDeps, id: string): Promise<number> {
  const config = await deps.loadConfig();
  if (config === undefined) {
    deps.say(NO_CONFIG);
    return 1;
  }
  const publicUrl = await resolvePublicUrl(deps, config);
  if (publicUrl === undefined) return printFunnelGuide(deps);

  const handle = deps.openAdmin(deps.home);
  try {
    const result = await handle.admin.rotate(id);
    await attachAndShow(deps, handle.admin, config, publicUrl, result);
    deps.say('이전 토큰은 7일 동안 계속 동작해요. 그 안에 새 파일을 기기에 넣어 주세요.');
  } finally {
    await handle.close();
  }
  return 0;
}

async function revokeCommand(deps: PhoneCliDeps, id: string, flags: PhoneFlags): Promise<number> {
  const handle = deps.openAdmin(deps.home);
  try {
    const device = await handle.admin.get(id);
    if (device === undefined) {
      deps.say(`그런 기기가 없어요: ${id}`);
      return 1;
    }
    if (flags.yes !== true) {
      const answer = await deps.prompter.choose(`"${device.name}" 연결을 지금 끊을까요? 바로 적용되고 되돌릴 수 없어요.`, [
        { value: 'yes', label: '지금 끊기' },
        { value: 'no', label: '취소' },
      ], 1);
      if (answer !== 'yes') {
        deps.say('취소했어요. 연결은 그대로예요.');
        return 0;
      }
    }
    await handle.admin.revoke(id);
    deps.say(`"${device.name}" 연결을 지금 끊었어요. 기기에서 보내는 신호는 바로 거부돼요.`);
  } finally {
    await handle.close();
  }
  return 0;
}

async function templateCommand(deps: PhoneCliDeps, flags: PhoneFlags): Promise<number> {
  const out = flags.out?.trim();
  if (out === undefined || out.length === 0) {
    deps.say(USAGE);
    return 2;
  }
  const config = await deps.loadConfig();
  const existing = await deps.readDir(out);
  if (existing.length > 0 && flags.yes !== true) {
    deps.say(`"${out}" 폴더에 파일이 이미 있어요. 덮어쓰려면 --yes를 붙여 주세요.`);
    return 1;
  }
  const templates = buildIosImportTemplates({
    assistantName: config?.assistant.name ?? 'ax-kit',
    language: config?.assistant.language ?? 'ko',
  });
  await deps.mkdir(out, DIRECTORY_MODE);
  for (const template of templates) {
    const path = join(out, template.fileName);
    await deps.writeFile(path, template.plistXml, FILE_MODE);
    deps.say(`만들었어요: ${path}`);
  }
  deps.say(`템플릿에는 주소와 토큰이 없어요. 서명할 수 있는 Mac에서 단축어로 열어 iCloud 링크를 만들어 주세요. 안내: ${IOS_GUIDE}`);
  return 0;
}

export async function phoneCommand(
  positionals: readonly string[],
  flags: PhoneFlags,
  deps: PhoneCliDeps,
): Promise<number> {
  const action = positionals[1];
  if (!ACTIONS.some((known) => known === action)) {
    deps.say(USAGE);
    return 2;
  }
  try {
    if (action === 'pair') return await pairCommand(deps, flags);
    if (action === 'list') return await listCommand(deps);
    if (action === 'template') return await templateCommand(deps, flags);
    if (action === 'apk') {
      const config = await deps.loadConfig();
      const publicUrl = config === undefined ? undefined : await resolvePublicUrl(deps, config);
      return await apkCommand(deps, publicUrl, flags.build === true);
    }
    if (action === 'install-mac') {
      const config = await deps.loadConfig();
      if (config === undefined || deps.installMac === undefined) {
        deps.say(NO_CONFIG);
        return 1;
      }
      const publicUrl = await resolvePublicUrl(deps, config);
      if (publicUrl === undefined) return printFunnelGuide(deps);
      return await deps.installMac(config, publicUrl, { ...(flags.to !== undefined ? { to: flags.to } : {}), ...(flags.user !== undefined ? { user: flags.user } : {}) });
    }
    if (action === 'funnel') return await deps.funnel({ ...(flags.fix === true ? { fix: true } : {}) });
    if (action === 'push-test') {
      if (deps.pushTest === undefined) {
        deps.say(USAGE);
        return 2;
      }
      return await deps.pushTest(positionals[2]);
    }
    const id = positionals[2];
    if (id === undefined) {
      deps.say(USAGE);
      return 2;
    }
    return action === 'rotate' ? await rotateCommand(deps, id) : await revokeCommand(deps, id, flags);
  } catch (error) {
    deps.say(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
