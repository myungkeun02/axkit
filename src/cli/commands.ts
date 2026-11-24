import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import type { Config, ConfigInput } from '../core/config/schema.js';
import { KeychainSecretStore, configPath, loadConfig, saveConfig } from '../core/index.js';
import { connectGoogleAccount, newPairingCode, pairOwnerOnDiscord } from '../app/onboarding.js';
import { createTtyPrompter } from './prompter.js';
import { askGoogle, drivePluginEntry, gmailPluginEntry } from './setup-google.js';
import { askOwner } from './setup-owner.js';

const BOT_TOKEN_SECRET = 'discord.bot-token';

const NO_CONFIG = '설정이 없어요. 먼저 `ax-kit setup`을 실행해 주세요.';

/** Opens a URL in the default browser on macOS. */
export function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('open', [url], (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

async function readConfigOrUndefined(path: string): Promise<Config | undefined> {
  try {
    return await loadConfig(path);
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function readUtf8(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

function baseConfig(existing: Config): ConfigInput {
  return {
    version: 1,
    assistant: existing.assistant,
    owner: existing.owner,
    channel: existing.channel,
    policy: existing.policy,
    llm: existing.llm,
    plugins: existing.plugins,
  };
}

/** `ax-kit connect google`: runs only the Google step, then saves the enabled connectors. */
export async function connectGoogleCommand(home: string): Promise<number> {
  const file = configPath(home);
  const existing = await readConfigOrUndefined(file);
  if (existing === undefined) {
    console.log(NO_CONFIG);
    return 1;
  }

  const prompter = createTtyPrompter();
  const result = await askGoogle({
    prompter,
    secrets: new KeychainSecretStore(),
    existing,
    openUrl: openInBrowser,
    connectGoogle: connectGoogleAccount,
    readFile: readUtf8,
    fileExists: exists,
  });
  if (result.calendar === undefined && result.gmail === undefined && result.drive === undefined) return 1;

  const plugins: Record<string, Record<string, unknown>> = { ...existing.plugins };
  if (result.calendar !== undefined) plugins['connector.google-calendar'] = { enabled: result.calendar };
  if (result.gmail !== undefined) plugins['connector.gmail'] = gmailPluginEntry(existing, result);
  if (result.drive !== undefined) plugins['connector.google-drive'] = drivePluginEntry(existing, result.drive, result.driveFolders);
  Object.assign(plugins, result.workspace);

  await saveConfig(file, { ...baseConfig(existing), plugins });
  prompter.say(`저장했어요: ${file}`);
  return 0;
}

/** `ax-kit pair`: re-runs DM pairing with the saved bot token and replaces the owner. */
export async function pairCommand(home: string): Promise<number> {
  const file = configPath(home);
  const existing = await readConfigOrUndefined(file);
  if (existing === undefined) {
    console.log(NO_CONFIG);
    return 1;
  }

  const secrets = new KeychainSecretStore();
  let token: string | undefined;
  try {
    token = await secrets.get(BOT_TOKEN_SECRET);
  } catch {
    token = undefined;
  }
  if (token === undefined || token.length === 0) {
    console.log(`디스코드 봇 토큰이 없어요. \`ax-kit secret set ${BOT_TOKEN_SECRET}\`로 넣어 주세요.`);
    return 1;
  }

  const prompter = createTtyPrompter();
  const userId = await askOwner({
    prompter,
    token,
    language: existing.assistant.language,
    newPairingCode,
    pairOwner: pairOwnerOnDiscord,
  });

  await saveConfig(file, { ...baseConfig(existing), owner: { discordUserId: userId } });
  prompter.say(`주인을 바꿨어요: ${userId}`);
  prompter.say('이전 주인의 메시지는 이제부터 지시로 인정되지 않아요.');
  return 0;
}
