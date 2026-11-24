import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openPhoneAdmin, phoneFilesDir, phoneStorePath, preparePhoneFiles } from '../../src/app/phone.js';
import type { PreparePhoneFilesInput } from '../../src/app/phone.js';
import type { Exec, ExecResult } from '../../src/mobile/files/sign.js';

const TOKEN = 'token_ABC-123_xyz';
const PUBLIC_URL = 'https://box.example.ts.net/';

interface Written {
  path: string;
  data: string;
  mode: number;
}

function fakeFs() {
  const made: { path: string; mode: number }[] = [];
  const written: Written[] = [];
  return {
    made,
    written,
    mkdir: async (path: string, mode: number): Promise<void> => {
      made.push({ path, mode });
    },
    writeFile: async (path: string, data: string, mode: number): Promise<void> => {
      written.push({ path, data, mode });
    },
  };
}

function fakeExec(shortcutsCode = 0) {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const exec: Exec = async (cmd, args): Promise<ExecResult> => {
    calls.push({ cmd, args });
    if (cmd === 'shortcuts' && shortcutsCode !== 0) {
      return { code: shortcutsCode, stdout: '', stderr: 'not signed in to iCloud' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, exec };
}

function spec(fs: ReturnType<typeof fakeFs>, exec: Exec, platform: 'ios' | 'android'): PreparePhoneFilesInput {
  return {
    platform,
    assistantName: '비서',
    language: 'ko',
    publicUrl: PUBLIC_URL,
    token: TOKEN,
    nonce: 'nonce123',
    filesDir: '/home/files/phone/nonce123',
    exec,
    mkdir: fs.mkdir,
    writeFile: fs.writeFile,
  };
}

describe('preparePhoneFiles', () => {
  it('writes and signs four iOS shortcuts under the pairing directory', async () => {
    const fs = fakeFs();
    const { calls, exec } = fakeExec();

    const result = await preparePhoneFiles(spec(fs, exec, 'ios'));

    expect(result.unsigned).toBe(false);
    expect(result.connection).toBeUndefined();
    expect(result.files).toHaveLength(4);
    expect(fs.made).toEqual([{ path: '/home/files/phone/nonce123', mode: 0o700 }]);
    expect(fs.written).toHaveLength(4);
    expect(fs.written.every((file) => file.mode === 0o600)).toBe(true);
    for (const file of fs.written) {
      expect(file.data).toContain('https://box.example.ts.net/m/v1/ingest');
      expect(file.data).toContain(`Bearer ${TOKEN}`);
    }

    expect(calls.map((call) => call.cmd)).toEqual(['plutil', 'shortcuts', 'plutil', 'shortcuts', 'plutil', 'shortcuts', 'plutil', 'shortcuts']);
    const signed = calls.filter((call) => call.cmd === 'shortcuts');
    for (const call of signed) {
      expect(call.args).toEqual([
        'sign',
        '--mode',
        'anyone',
        '--input',
        expect.stringMatching(/\.bin\.shortcut$/),
        '--output',
        expect.stringMatching(/\.shortcut$/),
      ]);
    }
    for (const file of result.files) {
      expect(file.contentType).toBe('application/octet-stream');
      expect(file.name).toMatch(/^비서 .+\.shortcut$/);
      expect(file.path).toMatch(/\/home\/files\/phone\/nonce123\/비서 .+\.shortcut$/);
    }
  });

  it('falls back to the unsigned XML files when iOS signing fails', async () => {
    const fs = fakeFs();
    const { exec } = fakeExec(1);

    const result = await preparePhoneFiles(spec(fs, exec, 'ios'));

    expect(result.unsigned).toBe(true);
    expect(result.warning).toContain('iCloud');
    expect(result.connection).toBe(`https://box.example.ts.net/m/v1/ingest|${TOKEN}`);
    expect(result.files).toHaveLength(4);
    for (const file of result.files) {
      expect(file.path).toMatch(/\.xml$/);
      expect(file.name).toMatch(/^비서 .+\.shortcut$/);
    }
    expect(fs.written.every((file) => file.path.endsWith('.xml'))).toBe(true);
  });

  it('writes one MacroDroid export for Android without running any command', async () => {
    const fs = fakeFs();
    const { calls, exec } = fakeExec();

    const result = await preparePhoneFiles(spec(fs, exec, 'android'));

    expect(calls).toEqual([]);
    expect(result).toMatchObject({ unsigned: false });
    expect(result.connection).toBeUndefined();
    expect(result.files).toHaveLength(1);
    const file = result.files[0];
    expect(file?.name).toBe('비서.macro');
    expect(file?.contentType).toBe('application/octet-stream');
    expect(fs.written[0]?.mode).toBe(0o600);
    const document = JSON.parse(fs.written[0]?.data ?? '{}') as {
      m_macros: { m_actionList: { requestConfig: { urlToOpen: string; headerParams: unknown[] } }[] }[];
    };
    expect(document.m_macros).toHaveLength(3);
    for (const macro of document.m_macros) {
      expect(macro.m_actionList[0]?.requestConfig.urlToOpen).toBe('https://box.example.ts.net/m/v1/ingest');
      expect(JSON.stringify(macro.m_actionList[0]?.requestConfig.headerParams)).toContain(`Bearer ${TOKEN}`);
    }
  });

  it('refuses a nonce that could escape the phone directory', () => {
    expect(() => phoneFilesDir('/home', '../escape')).toThrow('Invalid pairing nonce');
    expect(phoneFilesDir('/home', 'abc_DEF-123')).toBe('/home/files/phone/abc_DEF-123');
  });
});

describe('openPhoneAdmin', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('writes devices into the same SQLite file the daemon uses', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ax-kit-phone-'));
    directories.push(home);

    const first = openPhoneAdmin(home);
    expect(phoneStorePath(home)).toBe(join(home, 'data', 'ax-kit.db'));
    const paired = await first.admin.pair({ name: '내 아이폰', platform: 'ios' });
    await first.close();

    const second = openPhoneAdmin(home);
    try {
      const devices = await second.admin.list();
      expect(devices.map((device) => device.id)).toEqual([paired.device.id]);
      expect(devices[0]?.name).toBe('내 아이폰');
    } finally {
      await second.close();
    }
  });
});
