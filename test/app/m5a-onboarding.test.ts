import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app/build.js';
import { builtinPlugins } from '../../src/app/plugins.js';
import { parseConfig } from '../../src/core/config/load.js';
import { Contracts } from '../../src/core/contracts/index.js';
import { silentLogger } from '../../src/core/log/console-logger.js';
import { MemorySecretStore } from '../../src/core/secrets/memory.js';
import { discordChannel } from '../../src/channels/discord/plugin.js';
import { folderScanConnector } from '../../src/connectors/local-files/scan-plugin.js';
import { interviewSkill } from '../../src/skills/interview/plugin.js';
import { knowledgeSkill } from '../../src/skills/knowledge/plugin.js';
import { memorySkill } from '../../src/skills/memory/plugin.js';
import { onboardingSkill } from '../../src/skills/onboarding/plugin.js';
import { FakeDiscordPort } from '../channels/discord/fake-port.js';
import { flush } from '../core/helpers.js';

const OWNER = '11111111111111111';
const dirs: string[] = [];

async function settleUntil(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return;
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition was not reached');
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fakeHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'axkit-m5a-'));
  dirs.push(home);
  await mkdir(join(home, 'work', 'tidy-app', '.git'), { recursive: true });
  await writeFile(join(home, 'work', 'tidy-app', 'README.md'), '# Tidy app\n\nA to-do app for small teams.\n');
  await writeFile(join(home, 'work', 'plan.md'), '# 출시 계획\n\n연락처 kim@example.com\n');
  await mkdir(join(home, 'work', '.ssh'), { recursive: true });
  await writeFile(join(home, 'work', '.ssh', 'id_ed25519'), 'secret');
  await writeFile(join(home, 'work', '여권 사본.txt'), 'passport');
  return home;
}

describe('M5a first look (real temp folders, fake Discord, no model)', () => {
  it('scans, writes the knowledge documents, sends the card and applies the owner fix', async () => {
    const home = await fakeHome();
    const knowledgeDir = join(home, '.ax-kit', 'knowledge');
    const port = new FakeDiscordPort();
    const secrets = new MemorySecretStore();
    await secrets.set('discord.bot-token', 'token-1');
    const config = parseConfig({
      version: 1,
      assistant: { name: '나비', language: 'ko', timezone: 'Asia/Seoul' },
      owner: { discordUserId: OWNER },
      plugins: { 'skill.onboarding': { enabled: true, folders: ['~/work'], drive: false, signals: true } },
    });
    const app = await buildApp({
      config,
      secrets,
      log: silentLogger,
      plugins: [
        discordChannel({ ownerUserId: OWNER, expiresMinutes: 30, port: () => port }),
        memorySkill(),
        interviewSkill(),
        knowledgeSkill({ dir: knowledgeDir }),
        folderScanConnector({ home }),
        onboardingSkill(),
      ],
      storePath: ':memory:',
    });
    await app.start();
    try {
      const card = (): string | undefined =>
        port.sent.map((entry) => entry.payload.content).find((text) => text.includes('제가 이해한 당신'));
      await settleUntil(() => card() !== undefined);
      expect(card()).toContain('tidy-app');

      const names = await readdir(knowledgeDir);
      expect(names).toEqual(expect.arrayContaining(['README.md', '프로필.md', '변경기록.md', '프로젝트']));
      const project = await readFile(join(knowledgeDir, '프로젝트', 'tidy-app.md'), 'utf8');
      expect(project).toContain('~/work/tidy-app');
      expect((await stat(knowledgeDir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(knowledgeDir, 'README.md'))).mode & 0o777).toBe(0o600);
      const everything = (await Promise.all(names.filter((n) => n.endsWith('.md')).map((n) => readFile(join(knowledgeDir, n), 'utf8')))).join('\n');
      expect(everything).not.toContain('여권');
      expect(everything).not.toContain('id_ed25519');
      expect(project).not.toContain('kim@example.com');

      port.press({
        customId: 'choice:review:knowledge.profile:fix',
        userId: OWNER,
        channelId: `dm-${OWNER}`,
        messageId: 'card',
        ack: async () => undefined,
      });
      await settleUntil(() => port.sent.some((entry) => entry.payload.content.includes('번호와 바른 내용')));
      const cardText = card() ?? '';
      const line = cardText.split('\n').find((text) => text.includes('tidy-app'));
      const number = line?.match(/^(\d+)\./)?.[1];
      expect(number).toBeDefined();
      port.emitMessage({
        id: 'm1',
        channelId: `dm-${OWNER}`,
        authorId: OWNER,
        authorIsBot: false,
        isDm: true,
        content: `${number} tidy-app: 팀용 할 일 앱, 내가 만드는 중`,
        createdAt: new Date(),
      });
      await settleUntil(async () =>
        (await readFile(join(knowledgeDir, '프로젝트', 'tidy-app.md'), 'utf8')).includes('직접 고침'),
      );
      const fixed = await readFile(join(knowledgeDir, '프로젝트', 'tidy-app.md'), 'utf8');
      expect(fixed).toContain('팀용 할 일 앱');
      await settleUntil(async () =>
        (await readFile(join(knowledgeDir, '변경기록.md'), 'utf8')).includes('팀용 할 일 앱'),
      );

      const profile = app.host.capability(Contracts.knowledgeProfile);
      expect(await profile?.summary(600)).toContain('tidy-app');
    } finally {
      await app.stop('test');
    }
  });

  it('wires the knowledge skill by default and the scanner only after consent', async () => {
    const base = {
      version: 1 as const,
      assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
      owner: { discordUserId: OWNER },
    };
    const ids = (plugins: { manifest: { id: string } }[]): string[] => plugins.map((plugin) => plugin.manifest.id);
    const off = ids(builtinPlugins(parseConfig(base), { home: '/tmp/ax-kit-test-home' }));
    expect(off).toContain('skill.knowledge');
    expect(off).not.toContain('skill.onboarding');
    expect(off).not.toContain('connector.folder-scan');
    const on = ids(
      builtinPlugins(parseConfig({ ...base, plugins: { 'skill.onboarding': { enabled: true, folders: [] } } }), {}),
    );
    expect(on).toEqual(expect.arrayContaining(['skill.onboarding', 'connector.folder-scan']));

    const config = parseConfig({ ...base, plugins: { 'skill.onboarding': { enabled: true, folders: [] } } });
    const app = await buildApp({
      config,
      secrets: new MemorySecretStore(),
      log: silentLogger,
      plugins: builtinPlugins(config, { home: '/tmp/ax-kit-test-home' }),
      storePath: ':memory:',
    });
    await app.host.setupAll();
    const names = app.tools.list().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['knowledge.search', 'knowledge.read', 'onboarding.status']));
    expect(app.host.capability(Contracts.ownerReview)).toBeDefined();
    expect(app.host.capability(Contracts.folderScan)).toBeDefined();
    await app.stop('test');
  });
});
