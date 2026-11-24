import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Prompter } from './prompter.js';
import type { AsideRunner } from './setup-google-aside.js';

/** Aside comes in two parts: the browser app (signed in to the owner's Google account) and the CLI setup calls. */
export interface AsideInstall {
  appInstalled: () => Promise<boolean>;
  /** A runner when the CLI is installed now (looked up again each time). */
  runner: () => AsideRunner | undefined;
  /** Runs the official CLI installer on this terminal; the exit code. */
  installCli: () => Promise<number>;
  openUrl: (url: string) => Promise<void>;
}

export const ASIDE_SITE = 'https://aside.com';
export const ASIDE_CLI_INSTALL = 'curl -fsSL https://releases.aside.com/install.sh | bash';
const APP_TRIES = 3;

/**
 * Gets Aside ready in the middle of setup: the browser app first (the owner installs it and signs in to Google there),
 * then the CLI (official installer, after a yes). Undefined when either is not there in the end, so the manual way follows.
 */
export async function installAside(prompter: Prompter, deps: AsideInstall): Promise<AsideRunner | undefined> {
  if (!(await deps.appInstalled())) {
    prompter.say('Aside 브라우저 앱이 필요해요. 열리는 페이지에서 내려받아 설치하고, Aside 안에서 Google 계정에 로그인해 주세요.');
    await deps.openUrl(ASIDE_SITE).catch(() => prompter.say(`  ${ASIDE_SITE}`));
    let ready = false;
    for (let attempt = 0; attempt < APP_TRIES && !ready; attempt += 1) {
      const answer = (await prompter.text('설치하고 로그인했으면 엔터 (그만두려면 "건너뛰기")', { default: '' })).trim();
      if (answer === '건너뛰기' || answer.toLowerCase() === 'skip') return undefined;
      ready = await deps.appInstalled();
      if (!ready) prompter.say('아직 Aside 앱이 보이지 않아요. 응용 프로그램 폴더에 Aside가 있는지 확인해 주세요.');
    }
    if (!ready) return undefined;
  }
  let runner = deps.runner();
  if (runner === undefined) {
    const choice = await prompter.choose(
      'Aside CLI를 설치할까요? (셋업이 브라우저에 일을 시킬 때 써요)',
      [
        { value: 'install', label: '설치 (추천)', hint: ASIDE_CLI_INSTALL },
        { value: 'skip', label: '직접 할게요 (안내 보기)' },
      ],
      0,
    );
    if (choice !== 'install') return undefined;
    prompter.say('Aside CLI 설치 중…');
    const code = await deps.installCli();
    runner = deps.runner();
    if (code !== 0 || runner === undefined) {
      prompter.say(`설치하지 못했어요. 터미널에서 \`${ASIDE_CLI_INSTALL}\` 를 실행한 뒤 다시 해 주세요.`);
      return undefined;
    }
  }
  prompter.say('✓ Aside 준비됐어요.');
  return runner;
}

/** The app in /Applications or ~/Applications. */
export async function asideAppInstalled(home = homedir()): Promise<boolean> {
  for (const dir of ['/Applications', join(home, 'Applications')]) {
    try {
      await access(join(dir, 'Aside.app'));
      return true;
    } catch {
      // not here
    }
  }
  return false;
}
