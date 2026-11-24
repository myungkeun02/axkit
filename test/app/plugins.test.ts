import { describe, expect, it } from 'vitest';
import { builtinPlugins } from '../../src/app/plugins.js';
import type { ConfigInput } from '../../src/core/config/schema.js';
import { parseConfig } from '../../src/core/config/load.js';

const OWNER = '11111111111111111';

function config(
  plugins: NonNullable<ConfigInput['plugins']> = {},
  language: 'ko' | 'en' = 'ko',
) {
  return parseConfig({
    version: 1,
    assistant: { name: '비서', language, timezone: 'Asia/Seoul' },
    owner: { discordUserId: OWNER },
    plugins,
  });
}

function ids(input: ReturnType<typeof config>): string[] {
  return builtinPlugins(input).map((plugin) => plugin.manifest.id);
}

const BASE = [
  'channel.discord',
  'skill.greeting',
  'skill.assistant',
  'skill.work',
  'skill.ways',
  'connector.aside',
  'skill.routines',
  'skill.todo',
  'skill.briefing',
  'skill.memory',
  'skill.interview',
  'skill.day',
  'skill.docs',
  'bridge.mobile',
];

const M3 = [
  'connector.web',
      'skill.ops',
  'skill.spending',
  'skill.expenses',
  'skill.watch',
  'skill.standing',
  'skill.receipts',
  'skill.trip',
  'skill.files',
  'skill.knowledge',
];

describe('builtinPlugins', () => {
  it('includes the channel, skills, phone bridge and Korean pack by default in Korean', () => {
    expect(ids(config())).toEqual([...BASE, 'connector.ko-life', 'skill.local-life', ...M3]);
  });

  it('leaves the Korean pack off for other languages unless it is explicitly enabled', () => {
    expect(ids(config({}, 'en'))).toEqual([...BASE, ...M3]);
    expect(ids(config({ 'connector.ko-life': { enabled: true } }, 'en'))).toEqual([
      ...BASE,
      'connector.ko-life',
      'skill.local-life',
      ...M3,
    ]);
    expect(ids(config({ 'connector.ko-life': { enabled: false } }, 'en'))).toEqual([...BASE, ...M3]);
  });

  it('drops the Korean pack and its skill when the connector is disabled', () => {
    const found = ids(config({ 'connector.ko-life': { enabled: false } }));
    expect(found).not.toContain('connector.ko-life');
    expect(found).not.toContain('skill.local-life');
  });

  it('keeps the phone bridge unless it is explicitly disabled', () => {
    expect(ids(config())).toContain('bridge.mobile');
    expect(ids(config({ 'bridge.mobile': { enabled: false } }))).not.toContain('bridge.mobile');
  });

  it('adds the calendar connector and skill only when the plugin is enabled', () => {
    const found = ids(config({ 'connector.google-calendar': { enabled: true } }));
    expect(found).toContain('connector.google-calendar');
    expect(found).toContain('skill.calendar');
    expect(found).not.toContain('connector.gmail');
    expect(found).not.toContain('skill.mail');
  });

  it('adds the Gmail connector and mail skill only when the plugin is enabled', () => {
    const found = ids(config({ 'connector.gmail': { enabled: true } }));
    expect(found).toContain('connector.gmail');
    expect(found).toContain('skill.mail');
    expect(found).not.toContain('connector.google-calendar');
    expect(found).not.toContain('skill.calendar');
  });

  it('adds both Google plugins when both are enabled', () => {
    const found = ids(
      config({
        'connector.google-calendar': { enabled: true },
        'connector.gmail': { enabled: true },
      }),
    );
    expect(found).toEqual([
      ...BASE,
      'connector.ko-life',
      'skill.local-life',
      'connector.google-calendar',
      'skill.calendar',
      'connector.gmail',
      'skill.mail',
      ...M3,
    ]);
  });

  it('adds file connectors only when opted in and lets M3 skills be switched off', () => {
    const found = ids(
      config({
        'connector.local-files': { enabled: true, folders: ['~/Documents/notes'] },
        'connector.google-drive': { enabled: true, folderIds: ['abc'] },
        'skill.watch': { enabled: false },
      }),
    );
    expect(found).toContain('connector.local-files');
    expect(found).toContain('connector.google-drive');
    expect(found).not.toContain('skill.watch');
    expect(ids(config())).not.toContain('connector.local-files');
  });

  it('treats an explicitly disabled connector as off', () => {
    const found = ids(config({ 'connector.google-calendar': { enabled: false } }));
    expect(found).not.toContain('connector.google-calendar');
    expect(found).not.toContain('skill.calendar');
  });

  it('keeps every M4 optional plugin off by default', () => {
    const list = ids(config());
    for (const id of [
      'connector.kakao-desktop',
      'connector.discord-app',
      'skill.chat-inbox',
      'connector.browser',
      'skill.browser',
      'connector.macos-ocr',
      'skill.dev-assist',
      'skill.tuning',
      'skill.company',
      'skill.errands',
      'skill.sms-reader',
    ]) {
      expect(list).not.toContain(id);
    }
  });

  it('adds the errands skill only on the browser, and only when the owner turned it on', () => {
    expect(ids(config({ 'connector.browser': { enabled: true } }))).not.toContain('skill.errands');
    expect(ids(config({ 'skill.errands': { enabled: true } }))).not.toContain('skill.errands');
    expect(ids(config({ 'connector.browser': { enabled: true }, 'skill.errands': { enabled: true } }))).toContain('skill.errands');
  });

  it('adds the chat inbox with either screen reader and the browser skill with the connector', () => {
    const list = ids(
      config({
        'connector.discord-app': { enabled: true },
        'connector.browser': { enabled: true },
        'connector.macos-ocr': { enabled: true },
        'skill.dev-assist': { enabled: true },
        'skill.tuning': { enabled: true },
        'skill.company': { enabled: true },
      }),
    );
    expect(list).toEqual(
      expect.arrayContaining([
        'connector.discord-app',
        'skill.chat-inbox',
        'connector.browser',
        'skill.browser',
        'connector.macos-ocr',
        'skill.dev-assist',
        'skill.tuning',
        'skill.company',
      ]),
    );
    expect(list).not.toContain('connector.kakao-desktop');
    expect(ids(config({ 'connector.kakao-desktop': { enabled: true }, 'skill.chat-inbox': { enabled: false } }))).not.toContain(
      'skill.chat-inbox',
    );
  });

  it('adds 문자 읽기 when opted in, and it then owns text messages instead of the chat inbox', () => {
    expect(ids(config({ 'skill.chat-inbox': { sms: true } }))).toContain('skill.chat-inbox');
    const list = ids(config({ 'skill.sms-reader': { enabled: true }, 'skill.chat-inbox': { sms: true } }));
    expect(list).toContain('skill.sms-reader');
    expect(list).not.toContain('skill.chat-inbox');
  });
});
