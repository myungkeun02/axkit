import type { AxReader } from './reader.js';

export interface ScreenCheck {
  id: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface ScreenCheckDeps {
  reader: AxReader;
  appExists(path: string): Promise<boolean>;
  kakao: boolean;
  discord: boolean;
}

const ACCESSIBILITY_FIX =
  'System Settings > Privacy & Security > Accessibility: allow the app that runs ax-kit (Terminal or node), then restart ax-kit';

const APPS = {
  kakao: {
    id: 'screen.kakao-app',
    path: '/Applications/KakaoTalk.app',
    name: 'KakaoTalk',
    fix: 'Install KakaoTalk for Mac from the App Store.',
  },
  discord: {
    id: 'screen.discord-app',
    path: '/Applications/Discord.app',
    name: 'Discord',
    fix: 'Install Discord for Mac from discord.com/download.',
  },
} as const;

async function accessibilityCheck(reader: AxReader): Promise<ScreenCheck> {
  try {
    const trusted = await reader.trusted();
    if (trusted) {
      return { id: 'screen.accessibility', ok: true, detail: 'Accessibility access is allowed.' };
    }
    return {
      id: 'screen.accessibility',
      ok: false,
      detail: 'Accessibility access is not allowed.',
      fix: ACCESSIBILITY_FIX,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { id: 'screen.accessibility', ok: false, detail, fix: ACCESSIBILITY_FIX };
  }
}

async function appCheck(
  spec: (typeof APPS)[keyof typeof APPS],
  appExists: ScreenCheckDeps['appExists'],
): Promise<ScreenCheck> {
  try {
    const ok = await appExists(spec.path);
    return ok
      ? { id: spec.id, ok: true, detail: `${spec.name} is installed at ${spec.path}.` }
      : { id: spec.id, ok: false, detail: `${spec.path} was not found.`, fix: spec.fix };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { id: spec.id, ok: false, detail, fix: spec.fix };
  }
}

/** Doctor checks for the screen readers. It never calls dump, so chat contents are never read. */
export async function screenChatChecks(deps: ScreenCheckDeps): Promise<ScreenCheck[]> {
  const checks: ScreenCheck[] = [await accessibilityCheck(deps.reader)];
  if (deps.kakao) checks.push(await appCheck(APPS.kakao, deps.appExists));
  if (deps.discord) checks.push(await appCheck(APPS.discord, deps.appExists));
  return checks;
}
