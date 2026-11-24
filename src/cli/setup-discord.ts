import type { SecretStore } from '../core/secrets/types.js';
import type { Prompter } from './prompter.js';
import { PromptBack } from './prompter.js';

export type DiscordTokenInfo =
  | { ok: true; botUserId: string; username: string }
  | { ok: false; reason: string };

export type VerifyDiscordToken = (token: string) => Promise<DiscordTokenInfo>;

export interface DiscordSetupDeps {
  prompter: Prompter;
  secrets: SecretStore;
  verifyDiscordToken?: VerifyDiscordToken;
  openUrl?: (url: string) => Promise<void>;
}

const DEVELOPER_PORTAL = 'https://discord.com/developers/applications';
const USER_ME_URL = 'https://discord.com/api/v10/users/@me';
const MAX_ATTEMPTS = 3;
const PERMISSIONS = '274877991936';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function defaultVerifyDiscordToken(token: string): Promise<DiscordTokenInfo> {
  try {
    const response = await fetch(USER_ME_URL, { headers: { authorization: `Bot ${token}` } });
    if (!response.ok) return { ok: false, reason: `Discord API returned HTTP ${response.status}` };
    const data: unknown = await response.json();
    if (!isRecord(data) || typeof data.id !== 'string' || typeof data.username !== 'string') {
      return { ok: false, reason: 'unexpected response from Discord API' };
    }
    return { ok: true, botUserId: data.id, username: data.username };
  } catch {
    return { ok: false, reason: 'could not reach the Discord API' };
  }
}

export function buildInviteUrl(botUserId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${botUserId}&scope=bot%20applications.commands&permissions=${PERMISSIONS}`;
}

async function printChecklist(prompter: Prompter, openUrl: ((url: string) => Promise<void>) | undefined): Promise<void> {
  prompter.say('디스코드 봇을 준비할게요. 아래 순서대로 해 주세요:');
  prompter.say(`  1) 개발자 포털을 엽니다: ${DEVELOPER_PORTAL}`);
  prompter.say('  2) New Application 을 누르고 이름을 정하세요.');
  prompter.say('  3) 약관에 직접 동의해 주세요. (사람만 할 수 있어요)');
  prompter.say('  4) Bot 탭에서 Message Content Intent 를 켜세요.');
  prompter.say('  5) Reset Token 을 눌러 토큰을 복사하세요. (한 번만 보여요)');
  if (openUrl === undefined) return;
  try {
    await openUrl(DEVELOPER_PORTAL);
  } catch {
    prompter.say(`브라우저를 열지 못했어요. 직접 여세요: ${DEVELOPER_PORTAL}`);
  }
}

export interface DiscordSetupResult {
  botUserId: string;
  username: string;
  /** Kept in memory for owner pairing; never printed or written to the config. */
  token: string;
}

export async function configureDiscord(deps: DiscordSetupDeps): Promise<DiscordSetupResult> {
  await printChecklist(deps.prompter, deps.openUrl);
  const verify = deps.verifyDiscordToken ?? defaultVerifyDiscordToken;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const token = (await deps.prompter.secret('디스코드 봇 토큰: ')).trim();
    if (token.length === 0) {
      deps.prompter.say('토큰이 비어 있어요.');
      continue;
    }
    const result = await verify(token);
    if (!result.ok) {
      deps.prompter.say(`토큰을 확인하지 못했어요: ${result.reason}`);
      continue;
    }
    await deps.secrets.set('discord.bot-token', token);
    deps.prompter.say('초대 링크로 봇을 내 서버에 먼저 초대하세요 (DM을 보내려면 봇과 같은 서버에 있어야 해요).');
    deps.prompter.say(`봇을 서버에 초대하세요: ${buildInviteUrl(result.botUserId)}`);
    return { botUserId: result.botUserId, username: result.username, token };
  }

  // back to choosing where to talk (the apps need no token) instead of ending setup
  deps.prompter.say('디스코드 토큰을 세 번 확인하지 못했어요. 대화할 곳을 고르는 단계로 돌아갈게요. 앱으로 이야기하면 토큰이 필요 없어요.');
  throw new PromptBack();
}
