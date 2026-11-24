import { basename, dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { phoneCommand } from '../../src/cli/phone.js';
import type { PhoneCliDeps } from '../../src/cli/phone.js';
import { createScriptedPrompter } from '../../src/cli/prompter.js';
import { parseConfig } from '../../src/core/config/load.js';
import type { Config } from '../../src/core/config/schema.js';
import { ApkLinks } from '../../src/mobile/apk-links.js';
import { InstallLinks } from '../../src/mobile/install-links.js';
import { MobileAdmin } from '../../src/mobile/admin.js';
import { hashSecret, readDevices, tokenMatches } from '../../src/mobile/devices.js';
import type { PreparePhoneFilesSpec } from '../../src/app/phone.js';
import { FakeClock, MapKeyValueStore } from '../core/helpers.js';
import { NOW, seededRandom } from '../mobile/helpers.js';

const HOME = '/home';

function config(publicUrl?: string): Config {
  return parseConfig({
    version: 1,
    assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
    owner: { discordUserId: '11111111111111111' },
    plugins: {
      'bridge.mobile':
        publicUrl === undefined ? { enabled: true } : { enabled: true, publicUrl },
    },
  });
}

function configWithLinks(links: Record<string, string>): Config {
  return parseConfig({
    version: 1,
    assistant: { name: '비서', language: 'ko', timezone: 'Asia/Seoul' },
    owner: { discordUserId: '11111111111111111' },
    plugins: { 'bridge.mobile': { enabled: true, icloudLinks: links } },
  });
}

interface WrittenFile {
  path: string;
  data: string;
  mode: number;
}

interface Harness {
  deps: PhoneCliDeps;
  said: string[];
  admin: MobileAdmin;
  kv: MapKeyValueStore;
  prepared: PreparePhoneFilesSpec[];
  qrLinks: string[];
  made: { path: string; mode: number }[];
  written: WrittenFile[];
  files: Map<string, string[]>;
  funnelCalls: { fix?: boolean }[];
}

function harness(
  input: {
    config?: Config;
    answers?: readonly string[];
    running?: boolean;
    unsigned?: boolean;
  } = {},
): Harness {
  const said: string[] = [];
  const prepared: PreparePhoneFilesSpec[] = [];
  const qrLinks: string[] = [];
  const made: { path: string; mode: number }[] = [];
  const written: WrittenFile[] = [];
  const files = new Map<string, string[]>();
  const funnelCalls: { fix?: boolean }[] = [];
  const kv = new MapKeyValueStore();
  const admin = new MobileAdmin({ kv, clock: new FakeClock(NOW), randomBytes: seededRandom(7) });
  const prompter = createScriptedPrompter(input.answers ?? []);
  const running = input.running ?? true;
  const deps: PhoneCliDeps = {
    home: HOME,
    prompter,
    say: (line) => said.push(line),
    openAdmin: () => ({ admin, apk: new ApkLinks(kv, new FakeClock(NOW)), install: new InstallLinks(kv, new FakeClock(NOW)), close: async () => {} }),
    prepare: async (spec) => {
      prepared.push(spec);
      const result = {
        files: [{ name: 'f.bin', path: '/tmp/f.bin', contentType: 'application/octet-stream' }],
        unsigned: input.unsigned === true,
      };
      if (input.unsigned !== true) return result;
      return {
        ...result,
        warning: 'not signed in to iCloud',
        connection: `${spec.publicUrl.replace(/\/+$/, '')}/m/v1/ingest|${spec.token}`,
      };
    },
    tailscale: async () =>
      running
        ? { installed: true, running: true, dnsName: 'box.example.ts.net' }
        : { installed: true, running: false },
    qr: async (text) => {
      qrLinks.push(text);
      return `QR:${text}`;
    },
    loadConfig: async () => input.config ?? config(),
    mkdir: async (path, mode) => {
      made.push({ path, mode });
      if (!files.has(path)) files.set(path, []);
    },
    writeFile: async (path, data, mode) => {
      written.push({ path, data, mode });
      const directory = dirname(path);
      files.set(directory, [...(files.get(directory) ?? []), basename(path)]);
    },
    readDir: async (path) => files.get(path) ?? [],
    funnel: async (flags) => {
      funnelCalls.push(flags);
      return 0;
    },
    now: () => new Date('2026-11-17T12:00:00+09:00'),
  };
  return { deps, said, admin, kv, prepared, qrLinks, made, written, files, funnelCalls };
}

function output(said: readonly string[]): string {
  return said.join('\n');
}

describe('ax-kit phone pair', () => {
  it('prints the code, link and guide but never the token', async () => {
    const h = harness();
    const code = await phoneCommand(['phone', 'pair'], { platform: 'ios', name: '내 아이폰' }, h.deps);

    expect(code).toBe(0);
    const text = output(h.said);
    expect(text).toMatch(/페어링 코드: \d{6}/);
    expect(text).toContain('https://box.example.ts.net/m/p/');
    expect(text).toContain('docs/guides/phone-ios.md');
    expect(text).toContain('내 아이폰');

    const token = h.prepared[0]?.token;
    expect(token).toBeDefined();
    expect(text).not.toContain(token ?? '');
    expect(h.qrLinks[0]).toMatch(/^https:\/\/box\.example\.ts\.net\/m\/p\/[A-Za-z0-9_-]+$/);
    expect(h.prepared[0]?.filesDir).toMatch(/^\/home\/files\/phone\/[A-Za-z0-9_-]+$/);
    expect(h.prepared[0]?.publicUrl).toBe('https://box.example.ts.net');
  });

  it('prefers the configured public URL and prompts for platform and name', async () => {
    const h = harness({ config: config('https://fixed.example.com/'), answers: ['2', '회사 폰'] });
    const code = await phoneCommand(['phone', 'pair'], {}, h.deps);

    expect(code).toBe(0);
    expect(output(h.said)).toContain('https://fixed.example.com/m/p/');
    expect(output(h.said)).toContain('docs/guides/phone-android.md');
    expect(h.prepared[0]?.platform).toBe('android');
    expect(output(h.said)).toContain('회사 폰');
  });

  it('prints the Funnel guide and creates nothing when no public URL is available', async () => {
    const h = harness({ running: false, answers: [] });
    const code = await phoneCommand(['phone', 'pair'], {}, h.deps);

    expect(code).toBe(1);
    expect(output(h.said)).toContain('docs/guides/tailscale-funnel.md');
    expect(h.prepared).toHaveLength(0);
    expect(await h.admin.list()).toEqual([]);
  });

  it('rejects an unknown platform flag', async () => {
    const h = harness();
    const code = await phoneCommand(['phone', 'pair'], { platform: 'windows' }, h.deps);
    expect(code).toBe(2);
    expect(h.prepared).toHaveLength(0);
  });

  it('tells the owner that the old token keeps working after a rotate', async () => {
    const h = harness();
    const first = await h.admin.pair({ name: '내 아이폰', platform: 'ios' });
    h.said.length = 0;

    const code = await phoneCommand(['phone', 'rotate', first.device.id], {}, h.deps);

    expect(code).toBe(0);
    expect(output(h.said)).toContain('7일');
    const devices = await readDevices(h.kv);
    const device = devices.find((candidate) => candidate.id === first.device.id);
    expect(device?.previous).toBeDefined();
    expect(tokenMatches(device!, hashSecret(first.token), NOW)).toBe(true);
    expect(h.prepared[0]?.token).not.toBe(first.token);
  });
});

describe('ax-kit phone list and revoke', () => {
  it('lists devices without printing any token material', async () => {
    const h = harness();
    const paired = await h.admin.pair({ name: '내 아이폰', platform: 'ios' });
    await h.admin.markRotationReminded(paired.device.id, NOW);

    const code = await phoneCommand(['phone', 'list'], {}, h.deps);

    expect(code).toBe(0);
    const text = output(h.said);
    expect(text).toContain(paired.device.id);
    expect(text).toContain('내 아이폰');
    expect(text).not.toContain(paired.token);
    expect(text).not.toContain(paired.device.tokenHash);
  });

  it('revokes immediately with --yes', async () => {
    const h = harness();
    const paired = await h.admin.pair({ name: '내 아이폰', platform: 'ios' });

    const code = await phoneCommand(['phone', 'revoke', paired.device.id], { yes: true }, h.deps);

    expect(code).toBe(0);
    expect((await h.admin.get(paired.device.id))?.revokedAt).toBeDefined();
  });

  it('does nothing when the owner answers no', async () => {
    const h = harness({ answers: ['2'] });
    const paired = await h.admin.pair({ name: '내 아이폰', platform: 'ios' });

    const code = await phoneCommand(['phone', 'revoke', paired.device.id], {}, h.deps);

    expect(code).toBe(0);
    expect(output(h.said)).toContain('취소');
    expect((await h.admin.get(paired.device.id))?.revokedAt).toBeUndefined();
  });

  it('fails for an unknown device', async () => {
    const h = harness();
    expect(await phoneCommand(['phone', 'revoke', 'd_missing'], { yes: true }, h.deps)).toBe(1);
    expect(await phoneCommand(['phone', 'rotate', 'd_missing'], {}, h.deps)).toBe(1);
  });

  it('prints usage for an unknown subcommand', async () => {
    const h = harness();
    expect(await phoneCommand(['phone', 'nope'], {}, h.deps)).toBe(2);
    expect(output(h.said)).toContain('사용법');
  });
});

describe('ax-kit phone pair when signing fails', () => {
  it('prints the automatic guide, stores the connection string and never shows the token', async () => {
    const h = harness({ unsigned: true });
    const code = await phoneCommand(['phone', 'pair'], { platform: 'ios', name: '내 아이폰' }, h.deps);

    expect(code).toBe(0);
    const text = output(h.said);
    expect(text).toContain('iCloud');
    expect(text).toContain('ax-kit phone template --out');
    expect(text).toContain('icloudLinks');
    expect(text).toContain('docs/guides/phone-ios.md');

    const spec = h.prepared[0];
    const token = spec?.token ?? '';
    expect(token.length).toBeGreaterThan(0);
    expect(text).not.toContain(token);
    expect(text).not.toContain('https://box.example.ts.net/m/v1/ingest|');

    const record = await h.admin.getPairing(spec?.nonce ?? '');
    expect(record?.connection).toBe(`https://box.example.ts.net/m/v1/ingest|${token}`);
  });

  it('lists only well-formed iCloud links and points at the pairing page for the string', async () => {
    const h = harness({
      unsigned: true,
      config: configWithLinks({
        location: 'https://www.icloud.com/shortcuts/aaa111',
        sms: 'https://www.icloud.com/shortcuts/bbb222',
        steps: 'https://example.com/shortcuts/ccc333',
        voice_memo: 'https://www.icloud.com/shortcuts/ddd444',
      }),
    });
    const code = await phoneCommand(['phone', 'pair'], { platform: 'ios', name: '내 아이폰' }, h.deps);

    expect(code).toBe(0);
    const text = output(h.said);
    expect(text).toContain('https://www.icloud.com/shortcuts/aaa111');
    expect(text).toContain('https://www.icloud.com/shortcuts/bbb222');
    expect(text).toContain('https://www.icloud.com/shortcuts/ddd444');
    expect(text).not.toContain('example.com/shortcuts/ccc333');
    expect(text).toContain('단축어 추가');
    expect(text).toContain('6자리');
    expect(text).not.toContain(h.prepared[0]?.token ?? '');
  });

  it('does not store a connection string for a signed pairing', async () => {
    const h = harness();
    await phoneCommand(['phone', 'pair'], { platform: 'ios', name: '내 아이폰' }, h.deps);

    const record = await h.admin.getPairing(h.prepared[0]?.nonce ?? '');
    expect(record?.connection).toBeUndefined();
  });
});

describe('ax-kit phone template', () => {
  it('writes four generic templates with 0600 files in a 0700 directory', async () => {
    const h = harness();
    const code = await phoneCommand(['phone', 'template'], { out: '/tmp/templates' }, h.deps);

    expect(code).toBe(0);
    expect(h.made).toEqual([{ path: '/tmp/templates', mode: 0o700 }]);
    expect(h.written).toHaveLength(4);
    for (const file of h.written) {
      expect(file.path).toMatch(/^\/tmp\/templates\/비서 .+\.shortcut$/);
      expect(file.mode).toBe(0o600);
      expect(file.data).toContain('WFWorkflowImportQuestions');
      expect(file.data).toContain('연결 문자열을 붙여 넣어 주세요');
      expect(file.data).not.toMatch(/<string>https?:\/\//);
    }
    expect(output(h.said)).toContain('docs/guides/phone-ios.md');
  });

  it('refuses a non-empty directory unless --yes and then overwrites', async () => {
    const h = harness();
    h.files.set('/tmp/templates', ['old.txt']);

    expect(await phoneCommand(['phone', 'template'], { out: '/tmp/templates' }, h.deps)).toBe(1);
    expect(h.written).toHaveLength(0);
    expect(output(h.said)).toContain('--yes');

    h.said.length = 0;
    expect(
      await phoneCommand(['phone', 'template'], { out: '/tmp/templates', yes: true }, h.deps),
    ).toBe(0);
    expect(h.written).toHaveLength(4);
  });

  it('asks for --out', async () => {
    const h = harness();
    expect(await phoneCommand(['phone', 'template'], {}, h.deps)).toBe(2);
    expect(output(h.said)).toContain('--out');
  });
});

describe('ax-kit phone funnel', () => {
  it('hands funnel flags to the injected check', async () => {
    const h = harness();
    expect(await phoneCommand(['phone', 'funnel'], {}, h.deps)).toBe(0);
    expect(await phoneCommand(['phone', 'funnel'], { fix: true }, h.deps)).toBe(0);
    expect(h.funnelCalls).toEqual([{}, { fix: true }]);
  });
});

describe('ax-kit phone pair --app and apk', () => {
  it('pairs the app with an axkit:// QR and never prints the token', async () => {
    const h = harness();
    expect(await phoneCommand(['phone', 'pair'], { app: true }, h.deps)).toBe(0);
    const [device] = await h.admin.list();
    expect(device?.client).toBe('app');
    expect(h.qrLinks[0]).toMatch(/^axkit:\/\/pair\?u=https%3A%2F%2Fbox\.example\.ts\.net&n=[\w-]+&c=\d{6}$/);
    const nonce = new URL(h.qrLinks[0]!.replace('axkit://', 'https://x/')).searchParams.get('n')!;
    const record = await h.admin.getPairing(nonce);
    const token = record?.connection?.split('|')[1] ?? 'missing';
    expect(record?.connection?.startsWith('https://box.example.ts.net|')).toBe(true);
    expect(output(h.said)).not.toContain(token);
    expect(h.prepared).toHaveLength(0);
  });

  it('pairs a desktop app with --platform desktop and prints the link line', async () => {
    const h = harness();
    expect(await phoneCommand(['phone', 'pair'], { app: true, platform: 'desktop' }, h.deps)).toBe(0);
    const [device] = await h.admin.list();
    expect(device?.platform).toBe('desktop');
    expect(device?.name).toBe('내 데스크톱 앱');
    expect(output(h.said)).toContain(`링크: ${h.qrLinks[0]}`);
    expect(await phoneCommand(['phone', 'pair'], { app: true, platform: 'windows' }, h.deps)).toBe(2);
  });

  it('builds when no APK exists and shows a download QR with the install steps', async () => {
    const h = harness();
    let builds = 0;
    h.deps.apk = {
      existing: async () => undefined,
      build: async () => {
        builds += 1;
        return '/home/.ax-kit/files/apk/ax-kit.apk';
      },
    };
    expect(await phoneCommand(['phone', 'apk'], {}, h.deps)).toBe(0);
    expect(builds).toBe(1);
    expect(h.qrLinks[0]).toMatch(/^https:\/\/box\.example\.ts\.net\/m\/apk\/[\w-]+$/);
    expect(output(h.said)).toContain('알 수 없는 앱 설치');
  });

  it('reuses an existing APK unless --build', async () => {
    const h = harness();
    let builds = 0;
    h.deps.apk = { existing: async () => '/x.apk', build: async () => (builds += 1, '/y.apk') };
    await phoneCommand(['phone', 'apk'], {}, h.deps);
    expect(builds).toBe(0);
    await phoneCommand(['phone', 'apk'], { build: true }, h.deps);
    expect(builds).toBe(1);
  });
});
