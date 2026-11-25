import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GOOGLE_DRIVE_FILE_SCOPE, GOOGLE_DRIVE_SCOPE, GOOGLE_GMAIL_MODIFY_SCOPE } from '../../src/connectors/google/oauth.js';
import { parseConfig } from '../../src/core/config/load.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { runSetup } from '../../src/cli/setup.js';
import type { DiscordTokenInfo } from '../../src/cli/setup-discord.js';
import type { PairOwner, PairOwnerOptions } from '../../src/cli/setup-owner.js';
import type { ConnectGoogle, ConnectGoogleOptions } from '../../src/cli/setup-google.js';

const API_KEY = 'sk-ant-secret-123';
const DISCORD_TOKEN = 'discord-token-123';
const PAIRING_CODE = '123456';
const PAIRED_OWNER_ID = '12345678901234567';
const MANUAL_OWNER_ID = '98765432109876543';
const BOT_ID = '99999999999999999';
const CLIENT_JSON = JSON.stringify({ installed: { client_id: 'client-id', client_secret: 'client-secret' } });

const directories: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'axkit-setup-'));
  directories.push(home);
  return home;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function verifyDiscordToken(token: string): Promise<DiscordTokenInfo> {
  return Promise.resolve(
    token === DISCORD_TOKEN
      ? { ok: true, botUserId: BOT_ID, username: 'helper-bot' }
      : { ok: false, reason: 'invalid token' },
  );
}

describe('runSetup', () => {
  it('writes the M1 config through pairing, Google and scheduling', async () => {
    const home = await tempHome();
    const configFile = join(home, 'config.json');
    const secrets = new MemorySecretStore();
    const prompter = createScriptedPrompter([
      '나비', // 1/6 비서: name
      '1', // tone
      '', // what to call me
      '1', // 2/6 AI: Anthropic
      API_KEY,
      '1', // daily budget $0.5
      '2', // 3/6 대화할 곳: Discord
      DISCORD_TOKEN,
      '1', // 4/6 Google: connect
      '/tmp/google-client.json',
      '1', // no Drive / Gmail 정리
      '1', // no Docs/Sheets/Tasks/Contacts
      '2', // 5/6 briefing 08:00
      '1', // quiet hours 23–07
      '', // 저장 전에 고칠 단계: 이대로 저장
      '1', // 6/6 install the service
    ]);

    const pairCalls: PairOwnerOptions[] = [];
    const pairOwner: PairOwner = async (opts) => {
      pairCalls.push(opts);
      return { userId: PAIRED_OWNER_ID };
    };
    const googleCalls: ConnectGoogleOptions[] = [];
    const connectGoogle: ConnectGoogle = async (opts) => {
      googleCalls.push(opts);
      return { grantedScopes: ['calendar', 'gmail'], missingScopes: [] };
    };
    let installed = 0;

    const config = await runSetup({
      prompter,
      secrets,
      configFile,
      detectTimezone: () => 'Asia/Seoul',
      verifyDiscordToken,
      newPairingCode: () => PAIRING_CODE,
      pairOwner,
      connectGoogle,
      readFile: async () => CLIENT_JSON,
      fileExists: async () => true,
      installService: async () => {
        installed += 1;
        return 0;
      },
      openUrl: async () => undefined,
    });

    expect(config.assistant).toMatchObject({
      name: '나비',
      tone: 'polite',
      language: 'ko',
      timezone: 'Asia/Seoul',
      quietHours: { from: '23:00', to: '07:00' },
    });
    expect(config.assistant.ownerName).toBeUndefined();
    expect(config.owner.discordUserId).toBe(PAIRED_OWNER_ID);
    expect(config.policy.confirmWrites).toBe(false);
    expect(config.llm.providers.map((provider) => provider.id)).toEqual(['anthropic-fable', 'anthropic-opus', 'anthropic', 'anthropic-haiku']);
    expect(config.llm.budget).toEqual({ dailyUsd: 0.5, monthlyUsd: 10 });
    expect(config.plugins['skill.briefing']).toEqual({ enabled: true, at: '08:00' });
    expect(config.plugins['connector.google-calendar']).toEqual({ enabled: true });
    expect(config.plugins['connector.gmail']).toEqual({ enabled: true });

    expect(await secrets.get('discord.bot-token')).toBe(DISCORD_TOKEN);
    expect(await secrets.get('llm.anthropic.api-key')).toBe(API_KEY);
    expect(pairCalls).toEqual([{ token: DISCORD_TOKEN, code: PAIRING_CODE, language: 'ko' }]);
    expect(googleCalls[0]?.clientJson).toBe(CLIENT_JSON);
    expect(installed).toBe(1);

    const raw = await readFile(configFile, 'utf8');
    expect(() => parseConfig(JSON.parse(raw) as unknown)).not.toThrow();
    expect(raw.includes(API_KEY)).toBe(false);
    expect(raw.includes(DISCORD_TOKEN)).toBe(false);
    expect(raw.includes(CLIENT_JSON)).toBe(false);

    const said = prompter.said.join('\n');
    expect(said).toContain('페어링 코드: 123 456');
    expect(said).toContain(`client_id=${BOT_ID}`);
    expect(said).toContain('DM을 보내려면 봇과 같은 서버에 있어야 해요');
    expect(said).toContain('프로덕션으로 게시');
    expect(said.includes(API_KEY)).toBe(false);
    expect(said.includes(DISCORD_TOKEN)).toBe(false);
    expect(said.includes('client-secret')).toBe(false);
    expect(prompter.remaining()).toBe(0);
  });

  it('falls back to the manual owner id and leaves Google off when skipped', async () => {
    const home = await tempHome();
    const configFile = join(home, 'config.json');
    const secrets = new MemorySecretStore();
    const prompter = createScriptedPrompter([
      '나비',
      '1',
      '',
      '1',
      API_KEY,
      '1',
      '2', // Discord
      DISCORD_TOKEN,
      '2', // pairing failed: type the id
      MANUAL_OWNER_ID,
      '2', // Google later
      '4', // no briefing
      '4', // no quiet hours
      '', // 저장 전에 고칠 단계: 이대로 저장
      '2', // service later
    ]);

    const pairOwner: PairOwner = async () => {
      throw new Error('pairing code expired');
    };
    const connectGoogle: ConnectGoogle = async () => {
      throw new Error('connectGoogle must not run when Google is skipped');
    };
    let installed = 0;

    const config = await runSetup({
      prompter,
      secrets,
      configFile,
      detectTimezone: () => 'Asia/Seoul',
      verifyDiscordToken,
      newPairingCode: () => PAIRING_CODE,
      pairOwner,
      connectGoogle,
      readFile: async () => CLIENT_JSON,
      fileExists: async () => true,
      installService: async () => {
        installed += 1;
        return 0;
      },
      openUrl: async () => undefined,
    });

    expect(config.owner.discordUserId).toBe(MANUAL_OWNER_ID);
    expect(config.plugins['connector.google-calendar']).toBeUndefined();
    expect(config.plugins['connector.gmail']).toBeUndefined();
    expect(config.plugins['skill.briefing']).toEqual({ enabled: false });
    expect(config.assistant.quietHours).toBeUndefined();
    // what needs a confirmation is no longer asked on day one: sends, payments and deletes always do
    expect(config.policy.confirmWrites).toBe(false);
    expect(installed).toBe(0);
    expect(prompter.said.join('\n')).toContain('DM으로 주인을 확인하지 못했어요');
    expect(prompter.remaining()).toBe(0);
  });

  it('keeps Google connectors off when the calendar scope was not granted', async () => {
    const home = await tempHome();
    const configFile = join(home, 'config.json');
    const prompter = createScriptedPrompter([
      '나비',
      '1',
      '',
      '1',
      API_KEY,
      '1',
      '2', // Discord
      DISCORD_TOKEN,
      '1',
      '/tmp/google-client.json',
      '1',
      '1',
      '4',
      '4',
      '', // 저장 전에 고칠 단계: 이대로 저장
      '2',
    ]);
    const connectGoogle: ConnectGoogle = async () => ({
      grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
      missingScopes: ['https://www.googleapis.com/auth/calendar.events'],
    });

    const config = await runSetup({
      prompter,
      secrets: new MemorySecretStore(),
      configFile,
      detectTimezone: () => 'Asia/Seoul',
      verifyDiscordToken,
      newPairingCode: () => PAIRING_CODE,
      pairOwner: async () => ({ userId: PAIRED_OWNER_ID }),
      connectGoogle,
      readFile: async () => CLIENT_JSON,
      fileExists: async () => true,
      installService: async () => 0,
      openUrl: async () => undefined,
    });

    expect(config.plugins['connector.google-calendar']).toEqual({ enabled: false });
    expect(config.plugins['connector.gmail']).toEqual({ enabled: true });
    expect(prompter.said.join('\n')).toContain('캘린더 연결은 건너뛸게요');
  });

  it('asks for Drive and requests its read-only scope when chosen', async () => {
    const home = await tempHome();
    const prompter = createScriptedPrompter([
      '나비',
      '1',
      '',
      '1',
      API_KEY,
      '1',
      '2', // Discord
      DISCORD_TOKEN,
      '1',
      '/tmp/google-client.json',
      '2', // Drive
      '1',
      '2',
      '', // Drive 폴더 주소: 나중에
      '1',
      '', // 저장 전에 고칠 단계: 이대로 저장
      '1',
    ]);
    const googleCalls: ConnectGoogleOptions[] = [];
    const connectGoogle: ConnectGoogle = async (opts) => {
      googleCalls.push(opts);
      return { grantedScopes: [], missingScopes: [] };
    };

    await runSetup({
      prompter,
      secrets: new MemorySecretStore(),
      configFile: join(home, 'config.json'),
      detectTimezone: () => 'Asia/Seoul',
      verifyDiscordToken,
      newPairingCode: () => PAIRING_CODE,
      pairOwner: async () => ({ userId: PAIRED_OWNER_ID }),
      connectGoogle,
      readFile: async () => CLIENT_JSON,
      fileExists: async () => true,
      installService: async () => 0,
      openUrl: async () => undefined,
    });

    expect(googleCalls[0]?.extraScopes).toEqual([GOOGLE_DRIVE_SCOPE, GOOGLE_DRIVE_FILE_SCOPE]);
    const said = prompter.said.join('\n');
    expect(said).toContain('Google Drive를 읽기 전용으로 연결했어요');
    expect(said).toContain('Drive 폴더는 나중에 알려 주세요');
    expect(prompter.remaining()).toBe(0);
  });

  it('asks for Gmail 정리 as an opt-in and saves it only when gmail.modify was granted', async () => {
    const answers = ['나비', '1', '', '1', API_KEY, '1', '2', DISCORD_TOKEN, '1', '/tmp/google-client.json', '3', '1', '2', '1', '', '1'];
    const run = async (missingScopes: string[]) => {
      const home = await tempHome();
      const googleCalls: ConnectGoogleOptions[] = [];
      const prompter = createScriptedPrompter([...answers]);
      const config = await runSetup({
        prompter,
        secrets: new MemorySecretStore(),
        configFile: join(home, 'config.json'),
        detectTimezone: () => 'Asia/Seoul',
        verifyDiscordToken,
        newPairingCode: () => PAIRING_CODE,
        pairOwner: async () => ({ userId: PAIRED_OWNER_ID }),
        connectGoogle: async (opts) => {
          googleCalls.push(opts);
          return { grantedScopes: [], missingScopes };
        },
        readFile: async () => CLIENT_JSON,
        fileExists: async () => true,
        installService: async () => 0,
        openUrl: async () => undefined,
      });
      return { config, googleCalls, said: prompter.said.join('\n') };
    };

    const granted = await run([]);
    expect(granted.googleCalls[0]?.extraScopes).toEqual([GOOGLE_GMAIL_MODIFY_SCOPE]);
    expect(granted.config.plugins['connector.gmail']).toEqual({ enabled: true, organize: true });
    expect(granted.said).toContain('Gmail 정리(보관·라벨)를 맡길 수 있게 됐어요');

    const declined = await run([GOOGLE_GMAIL_MODIFY_SCOPE]);
    expect(declined.config.plugins['connector.gmail']).toEqual({ enabled: true });
    expect(declined.said).toContain('Gmail 정리 권한을 허락하지 않아');
  });

  it('app mode skips Discord entirely and saves no owner id', async () => {
    const home = await tempHome();
    const configFile = join(home, 'config.json');
    const prompter = createScriptedPrompter(['나비', '1', '', '1', API_KEY, '1', '1', '2', '4', '4', '', '2']);
    const config = await runSetup({
      prompter,
      secrets: new MemorySecretStore(),
      configFile,
      detectTimezone: () => 'Asia/Seoul',
      verifyDiscordToken: async () => {
        throw new Error('Discord must not be asked in app mode');
      },
      pairOwner: async () => {
        throw new Error('Discord must not be asked in app mode');
      },
      connectGoogle: async () => ({ grantedScopes: [], missingScopes: [] }),
      readFile: async () => CLIENT_JSON,
      fileExists: async () => true,
      openUrl: async () => undefined,
    });
    expect(config.channel).toBe('app');
    expect(config.owner.discordUserId).toBeUndefined();
    expect(prompter.said.join('\n')).toContain('ax-kit phone pair --app');
  });
});
